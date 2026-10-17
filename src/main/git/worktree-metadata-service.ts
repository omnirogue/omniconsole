import { normalize } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import type { ChildProcessHandle, ProcessSpec } from '../../shared/child-process/run-process'
import { worktreeMetadataProcessSpec } from './worktree-metadata-process'
import {
  createWorktreeMetadataDecoder,
  isWorktreeMetadataRequest,
  WORKTREE_METADATA_INPUT_BYTES,
  WORKTREE_METADATA_MAX_REQUESTS
} from './worktree-metadata-protocol'
import type {
  WorktreeMetadataOperation,
  WorktreeMetadataRequest,
  WorktreeMetadataResult
} from './worktree-metadata-protocol'

const MAX_CHILDREN = 2
const MAX_PENDING_PATHS = 2048
const ADMISSION_MS = 2_000
const UNKNOWN_COOLDOWN_MS = 30_000

type Result = WorktreeMetadataResult | undefined
type Consumer = (value: Result) => void
type Pending = {
  key: string
  request: WorktreeMetadataRequest
  consumers: Set<Consumer>
  admission: ReturnType<typeof setTimeout>
  batch?: Batch
  started: boolean
  finished: boolean
}
type Batch = {
  members: Pending[]
  controller: AbortController
  exited: boolean
  leaked: boolean
  done: Promise<void>
}

/** A timeout releases callers; only observed child termination releases a process slot. */
export class WorktreeMetadataService {
  private readonly pending = new Map<string, Pending>()
  private readonly queued = new Set<Pending>()
  private readonly children = new Set<Batch>()
  private readonly cooldown = new Map<string, number>()
  private stopped = false
  private disabled = false
  private pumping = false

  constructor(
    private readonly run: typeof runProcess = runProcess,
    private readonly makeSpec: () => ProcessSpec = () => worktreeMetadataProcessSpec()
  ) {}

  isExhausted(): boolean {
    return this.disabled
  }

  async probe(
    operation: WorktreeMetadataOperation,
    paths: readonly string[],
    signal?: AbortSignal
  ): Promise<ReadonlyMap<string, Result>> {
    const unique = [...new Set(paths)]
    return new Map(
      await Promise.all(
        unique.map(
          async (path) => [path, await this.subscribe({ operation, path }, signal)] as const
        )
      )
    )
  }

  stop(): Promise<void> {
    this.stopped = true
    for (const pending of this.queued) {
      this.finish(pending)
    }
    const children = [...this.children]
    for (const child of children) {
      child.controller.abort()
    }
    return Promise.all(children.map((child) => child.done)).then(() => undefined)
  }

  private subscribe(request: WorktreeMetadataRequest, signal?: AbortSignal): Promise<Result> {
    const pathKey = normalize(request.path)
    if (
      this.stopped ||
      this.disabled ||
      signal?.aborted ||
      !isWorktreeMetadataRequest(request) ||
      (this.cooldown.get(pathKey) ?? 0) > Date.now()
    ) {
      return Promise.resolve(undefined)
    }
    this.cooldown.delete(pathKey)
    const key = `${request.operation}:${pathKey}`
    let pending = this.pending.get(key)
    if (!pending) {
      if (this.pending.size >= MAX_PENDING_PATHS) {
        return Promise.resolve(undefined)
      }
      const created: Pending = {
        key,
        request,
        consumers: new Set(),
        admission: setTimeout(() => this.finish(created), ADMISSION_MS),
        started: false,
        finished: false
      }
      pending = created
      this.pending.set(key, created)
      this.queued.add(created)
      this.schedulePump()
    }
    const owned = pending
    return new Promise((resolve) => {
      const settle: Consumer = (value) => {
        signal?.removeEventListener('abort', abort)
        owned.consumers.delete(settle)
        resolve(value)
      }
      const abort = (): void => {
        settle(undefined)
        if (!owned.batch && owned.consumers.size === 0) {
          this.finish(owned)
        } else if (
          owned.batch?.members.every((member) => member.finished || member.consumers.size === 0)
        ) {
          owned.batch.controller.abort()
        }
      }
      owned.consumers.add(settle)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) {
        abort()
      }
    })
  }

  private finish(pending: Pending, result?: WorktreeMetadataResult): void {
    if (pending.finished) {
      return
    }
    pending.finished = true
    clearTimeout(pending.admission)
    this.queued.delete(pending)
    this.pending.delete(pending.key)
    for (const consumer of pending.consumers) {
      consumer(result)
    }
  }

  private schedulePump(): void {
    if (this.pumping) {
      return
    }
    this.pumping = true
    queueMicrotask(() => {
      this.pumping = false
      this.pump()
    })
  }

  private pump(): void {
    while (
      !this.stopped &&
      !this.disabled &&
      this.children.size < MAX_CHILDREN &&
      this.queued.size
    ) {
      const members: Pending[] = []
      const readable = [...this.queued].some((pending) => pending.request.operation === 'readable')
      let bytes = 2
      for (const pending of this.queued) {
        if ((pending.request.operation === 'readable') !== readable) {
          continue
        }
        const requestBytes = Buffer.byteLength(JSON.stringify(pending.request)) + 1
        if (bytes + requestBytes > WORKTREE_METADATA_INPUT_BYTES) {
          break
        }
        bytes += requestBytes
        members.push(pending)
        this.queued.delete(pending)
        clearTimeout(pending.admission)
        if (members.length === WORKTREE_METADATA_MAX_REQUESTS) {
          break
        }
      }
      const batch: Batch = {
        members,
        controller: new AbortController(),
        exited: false,
        leaked: false,
        done: Promise.resolve()
      }
      members.forEach((pending) => {
        pending.batch = batch
      })
      this.children.add(batch)
      batch.done = this.runBatch(batch)
    }
  }

  private quarantineChild(batch: Batch, child: ChildProcessHandle, startedAt: number): void {
    if (batch.exited || batch.leaked) {
      return
    }
    batch.leaked = true
    console.warn('[worktree-metadata] child exit unverifiable', {
      pid: child.pid,
      elapsedMs: Date.now() - startedAt
    })
    // An uninterruptible OS read must not pin the desktop's Node cleanup handles.
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      stream?.destroy()
    }
    child.unref()
    if ([...this.children].filter((owned) => owned.leaked).length >= MAX_CHILDREN) {
      this.disabled = true
      for (const pending of this.queued) {
        this.finish(pending)
      }
    }
  }

  private async runBatch(batch: Batch): Promise<void> {
    const requests = batch.members.map((member) => member.request)
    const startedAt = Date.now()
    const decode = createWorktreeMetadataDecoder(requests, (record) => {
      const pending = batch.members[record.index]
      if (record.phase === 'start') {
        pending.started = true
      } else {
        this.finish(pending, record)
      }
    })
    let submitted = false
    try {
      const spec = this.makeSpec()
      submitted = true
      await this.run({
        ...spec,
        input: JSON.stringify(requests),
        signal: batch.controller.signal,
        onStdout: decode,
        onChildTerminated: () => {
          batch.exited = true
          this.children.delete(batch)
          this.schedulePump()
        },
        onChildExitUnverified: (child) => this.quarantineChild(batch, child, startedAt)
      })
    } catch {
      // Optional metadata is unknown when the helper cannot run.
    } finally {
      if (!submitted) {
        this.children.delete(batch)
        this.schedulePump()
      }
      for (const pending of batch.members) {
        if (
          !pending.finished &&
          pending.started &&
          pending.consumers.size > 0 &&
          !batch.controller.signal.aborted
        ) {
          const pathKey = normalize(pending.request.path)
          this.cooldown.delete(pathKey)
          this.cooldown.set(pathKey, Date.now() + UNKNOWN_COOLDOWN_MS)
          if (this.cooldown.size > MAX_PENDING_PATHS) {
            this.cooldown.delete(this.cooldown.keys().next().value!)
          }
        }
        // Unstarted paths stay eligible: later polls advance past stalled paths in cooldown.
        this.finish(pending)
      }
    }
  }
}

const worktreeMetadataService = new WorktreeMetadataService()

export function probeWorktreeMetadata(
  operation: WorktreeMetadataOperation,
  paths: readonly string[],
  signal?: AbortSignal
): Promise<ReadonlyMap<string, WorktreeMetadataResult | undefined>> {
  return worktreeMetadataService.probe(operation, paths, signal)
}

export function stopWorktreeMetadataProbes(): Promise<void> {
  return worktreeMetadataService.stop()
}

export function areWorktreeMetadataProbesExhausted(): boolean {
  return worktreeMetadataService.isExhausted()
}
