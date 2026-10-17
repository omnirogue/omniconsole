import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileDurableSync } from '../../durable-file-write'
import {
  runProcess,
  type ChildProcessHandle,
  type ProcessSpec
} from '../../../shared/child-process/run-process'
import { finishWorkflowProcessGroup } from './workflow-process-group'
import { workflowEvidenceDigest } from './workflow-checkpoint-store'
import type { WorkflowAttemptLaunch } from './workflow-durable-call'
import { createWorkflowStdoutLines } from './workflow-stdout-lines'

import { readWorkflowProcessReceipt } from './workflow-process-receipt'

type LaunchInput = Parameters<WorkflowAttemptLaunch>[0]
type Command = Pick<ProcessSpec, 'program' | 'args' | 'cwd' | 'env' | 'input'>

/** Live observers never affect a launch or its evidence. */
function observe(notify: () => void): void {
  try {
    notify()
  } catch {
    /* Live view only. */
  }
}

/** Host-resolved commands only; credentials and ambient environment never enter receipts. */
export function createWorkflowLocalProcessLaunch(options: {
  directory: string
  executionId: string
  hostId: string
  ownerIncarnation: string
  fence: number
  command: (input: LaunchInput) => Command
  timeoutMs: number
  maxOutputBytes: number
  /**
   * Rewrites or drops (null) each complete stdout line before the receipt stores it, so bulky
   * streamed noise never counts against the cap. Parsers must accept the stored form.
   */
  storeLine?: (line: string) => string | null
  /** Each complete stdout line as it arrives; live view only, never evidence. */
  onLine?: (line: string) => void
  onSpawned?: (at: number) => void
  onExited?: (at: number) => void
  /** Ends the process group once stdout stays silent this long; the result records it. */
  stallMs?: number
  /** Extra launch evidence recorded in launch.json, e.g. the host a dispatched seat ran on. */
  launchEvidence?: Record<string, unknown>
}): WorkflowAttemptLaunch {
  if (process.platform === 'win32') {
    throw new Error('Local workflow process receipts require a certified Windows adapter')
  }
  if (
    !options.executionId ||
    !options.hostId.trim() ||
    !options.ownerIncarnation.trim() ||
    !Number.isSafeInteger(options.fence) ||
    options.fence < 1 ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    !Number.isSafeInteger(options.maxOutputBytes) ||
    options.maxOutputBytes < 1 ||
    options.maxOutputBytes > 8 * 1024 * 1024 ||
    (options.stallMs !== undefined &&
      !(Number.isSafeInteger(options.stallMs) && options.stallMs > 0))
  ) {
    throw new Error('Invalid workflow process launch limits or owner')
  }
  return async (input) => {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.attemptId)) {
      throw new Error('Invalid workflow attempt identity')
    }
    input.signal.throwIfAborted()
    const command = options.command(input)
    const expected = {
      directory: options.directory,
      hostId: options.hostId,
      ownerIncarnation: options.ownerIncarnation,
      executionId: options.executionId,
      fence: options.fence,
      attemptId: input.attemptId,
      callId: input.call.id,
      ordinal: input.ordinal,
      commandDigest: workflowEvidenceDigest(JSON.stringify([command.program, command.args])),
      inputDigest: workflowEvidenceDigest(command.input ?? ''),
      maxOutputBytes: options.maxOutputBytes
    }
    input.recordPreparation(expected)
    // Exclusive directory creation also prevents reuse after an ambiguous prior launch.
    const directory = join(options.directory, input.attemptId)
    mkdirSync(directory, { mode: 0o700 })
    const launchPath = join(directory, 'launch.json')
    const terminalPath = join(directory, 'terminal.json')
    let child: ChildProcessHandle | undefined
    let closed = false
    let launchJson = ''
    const lines =
      options.storeLine || options.onLine
        ? createWorkflowStdoutLines({
            maxBytes: options.maxOutputBytes,
            storeLine: options.storeLine,
            onLine: options.onLine
          })
        : undefined
    const exited = () => {
      clearTimeout(stallTimer)
      if (child) {
        observe(() => options.onExited?.(Date.now()))
      }
    }
    // Silence past stallMs aborts like a stop, so runProcess ends the whole group.
    const stall = new AbortController()
    let stallTimer: ReturnType<typeof setTimeout> | undefined
    let stalledAfterMs: number | undefined
    const { stallMs } = options
    const arm = () => {
      if (stallMs === undefined) {
        return
      }
      clearTimeout(stallTimer)
      stallTimer = setTimeout(() => {
        if (!input.signal.aborted && !closed) {
          stalledAfterMs = stallMs
          stall.abort()
        }
      }, stallMs)
    }
    const captured = await runProcess({
      ...command,
      signal: stallMs === undefined ? input.signal : AbortSignal.any([input.signal, stall.signal]),
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
      terminationBarrier: true,
      ...(lines || stallMs !== undefined
        ? {
            onStdout: (chunk: Buffer | string) => {
              arm()
              lines?.write(chunk)
            }
          }
        : {}),
      onSpawn: (spawned) => {
        child = spawned
        arm()
        launchJson = JSON.stringify({
          ...options.launchEvidence,
          version: 2,
          hostId: options.hostId,
          ownerIncarnation: options.ownerIncarnation,
          executionId: options.executionId,
          fence: options.fence,
          attemptId: input.attemptId,
          callId: input.call.id,
          ordinal: input.ordinal,
          ownerPid: process.pid,
          pid: spawned.pid,
          processGroupId: spawned.pid,
          platform: process.platform,
          launchedAt: new Date().toISOString(),
          commandDigest: workflowEvidenceDigest(JSON.stringify([command.program, command.args])),
          inputDigest: workflowEvidenceDigest(command.input ?? '')
        })
        writeFileDurableSync(`${launchPath}.tmp`, launchPath, launchJson)
        input.recordLaunch(launchPath)
        observe(() => options.onSpawned?.(Date.now()))
      },
      onChildTerminated: () => {
        closed = true
      }
    }).finally(exited)
    const stored = options.storeLine && lines ? lines.result(captured) : captured
    const result = stalledAfterMs === undefined ? stored : { ...stored, stalledAfterMs }
    if (!child?.pid || !closed) {
      throw new Error('Workflow process exit is unverifiable')
    }
    const groupCleanupRequired = await finishWorkflowProcessGroup(child)
    if (readFileSync(launchPath, 'utf8') !== launchJson) {
      throw new Error('Workflow process launch evidence changed')
    }
    const receipt = {
      attemptId: input.attemptId,
      processReceiptRef: launchPath,
      liveness: 'exited' as const
    }
    const terminal = JSON.stringify({
      ...receipt,
      executionId: options.executionId,
      fence: options.fence,
      launchDigest: workflowEvidenceDigest(launchJson),
      exitedAt: new Date().toISOString(),
      groupCleanupRequired,
      result,
      resultDigest: workflowEvidenceDigest(JSON.stringify(result))
    })
    writeFileDurableSync(`${terminalPath}.tmp`, terminalPath, terminal)
    return readWorkflowProcessReceipt(expected)
  }
}
