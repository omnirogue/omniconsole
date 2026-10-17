import { spawnProcess } from '../../shared/child-process/run-process'
import { StringDecoder } from 'node:string_decoder'
import { createNdjsonParser } from '../daemon/ndjson'
import { RetryableProcessExitProof } from '../../shared/child-process/retryable-process-exit-proof'
import { forceTerminateProcessTree } from '../../shared/child-process/process-tree-termination'
import { waitForProcessExitUntil } from '../codex/codex-process-exit-deadline'

export type AcpJsonRpcServerRequest = {
  id: number | string
  method: string
  params: unknown
}

export type AcpJsonRpcConnectionHandlers = {
  onNotification?: (method: string, params: unknown) => void
  onServerRequest?: (request: AcpJsonRpcServerRequest) => void
  onExit?: (error: Error) => void
}

export type AcpJsonRpcLaunch = {
  command: string
  args: readonly string[]
  cwd?: string
  env?: Record<string, string>
}

export type AcpInitializeResult = {
  protocolVersion?: number
  authMethods?: { id?: string }[]
  agentCapabilities?: {
    loadSession?: boolean
    promptCapabilities?: { image?: boolean }
  }
}

export type AcpJsonRpcConnection = {
  readonly pid: number | undefined
  readonly closed: boolean
  readonly initialize: AcpInitializeResult
  request: (
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number }
  ) => Promise<unknown>
  notify: (method: string, params?: Record<string, unknown>) => void
  respond: (id: number | string, result: unknown) => void
  respondError: (id: number | string, code: number, message: string) => void
  close: () => Promise<boolean>
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const INITIALIZE_TIMEOUT_MS = 20_000

export class AcpJsonRpcRequestError extends Error {
  constructor(
    message: string,
    readonly code?: number
  ) {
    super(message)
    this.name = 'AcpJsonRpcRequestError'
  }
}

export class AcpChildExitUnprovenError extends Error {
  constructor(
    cause: unknown,
    readonly retryClose: () => Promise<boolean>
  ) {
    super('ACP initialization failed and child exit is unproven', { cause })
    this.name = 'AcpChildExitUnprovenError'
  }
}

export async function openAcpJsonRpcConnection(
  launch: AcpJsonRpcLaunch,
  handlers: AcpJsonRpcConnectionHandlers = {},
  spawnImpl: typeof spawnProcess = spawnProcess
): Promise<AcpJsonRpcConnection> {
  const child = spawnImpl({
    program: launch.command,
    args: launch.args,
    cwd: launch.cwd,
    env: { ...process.env, ...launch.env },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const exitProof = new RetryableProcessExitProof()
  let closed = false
  let exitObserved = false
  let resolveExit = (): void => undefined
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve
  })
  let nextId = 1
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()

  const write = (message: unknown): boolean => {
    if (child.stdin.destroyed || !child.stdin.writable) {
      return false
    }
    child.stdin.write(`${JSON.stringify(message)}\n`)
    return true
  }

  const framer = createNdjsonParser(
    (record) => {
      if (typeof record !== 'object' || record === null) {
        return
      }
      const frame = record as Record<string, unknown>
      if (frame.jsonrpc !== '2.0') {
        return
      }
      if (
        typeof frame.method === 'string' &&
        (typeof frame.id === 'number' || typeof frame.id === 'string')
      ) {
        handlers.onServerRequest?.({
          id: frame.id as number | string,
          method: frame.method,
          params: frame.params
        })
        return
      }
      if (typeof frame.method === 'string') {
        handlers.onNotification?.(frame.method, frame.params)
        return
      }
      if (typeof frame.id === 'number') {
        const waiter = pending.get(frame.id)
        if (!waiter) {
          return
        }
        pending.delete(frame.id)
        if (frame.error && typeof frame.error === 'object') {
          const error = frame.error as { message?: string; code?: number }
          waiter.reject(
            new AcpJsonRpcRequestError(error.message ?? 'ACP request failed', error.code)
          )
          return
        }
        waiter.resolve(frame.result)
      }
    },
    () => undefined
  )

  const decoder = new StringDecoder('utf8')
  child.stdout.on('data', (chunk: Buffer) => framer.feed(decoder.write(chunk)))
  let stderrTail = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4096)
  })

  const observeExit = (error: Error): void => {
    if (exitObserved) {
      closed = true
      return
    }
    exitObserved = true
    closed = true
    resolveExit()
    for (const waiter of pending.values()) {
      waiter.reject(error)
    }
    pending.clear()
    handlers.onExit?.(error)
  }

  child.on('exit', (code, signal) => {
    observeExit(
      new Error(
        `ACP child exited (${code ?? signal ?? 'unknown'})${stderrTail ? `: ${stderrTail.trim()}` : ''}`
      )
    )
  })
  const rejectPending = (error: Error): void => {
    closed = true
    for (const waiter of pending.values()) {
      waiter.reject(error)
    }
    pending.clear()
  }
  child.on('error', (error) => {
    if (child.pid === undefined) {
      observeExit(error)
    } else {
      rejectPending(error)
    }
  })
  child.stdin.on('error', rejectPending)

  const request = (
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number }
  ): Promise<unknown> => {
    if (closed) {
      return Promise.reject(new AcpJsonRpcRequestError('ACP connection is closed'))
    }
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timeoutMs = options?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              pending.delete(id)
              reject(new AcpJsonRpcRequestError(`ACP ${method} timed out`))
            }, timeoutMs)
          : null
      timer?.unref?.()
      pending.set(id, {
        resolve: (value) => {
          if (timer) {
            clearTimeout(timer)
          }
          resolve(value)
        },
        reject: (error) => {
          if (timer) {
            clearTimeout(timer)
          }
          reject(error)
        }
      })
      if (!write({ jsonrpc: '2.0', id, method, params: params ?? {} })) {
        pending
          .get(id)
          ?.reject(
            new AcpJsonRpcRequestError(`ACP ${method} could not be written; stdin is closed`)
          )
        pending.delete(id)
      }
    })
  }

  const close = (): Promise<boolean> =>
    exitProof.run(async () => {
      if (!exitObserved) {
        child.kill('SIGTERM')
        await waitForProcessExitUntil(exitPromise, 1_500)
      }
      if (!exitObserved) {
        await forceTerminateProcessTree(child)
        await waitForProcessExitUntil(exitPromise, 1_000)
      }
      return exitObserved
    })

  try {
    const initialize = (await request(
      'initialize',
      {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false
        },
        clientInfo: { name: 'omni', title: 'OmniConsole', version: '0.0.0' }
      },
      { timeoutMs: INITIALIZE_TIMEOUT_MS }
    )) as AcpInitializeResult
    if (initialize?.protocolVersion !== 1 || closed) {
      throw new AcpJsonRpcRequestError('ACP initialize did not negotiate protocol version 1')
    }
    return {
      get pid() {
        return child.pid
      },
      get closed() {
        return closed
      },
      initialize: initialize ?? {},
      request,
      notify: (method, params) => {
        write({ jsonrpc: '2.0', method, params: params ?? {} })
      },
      respond: (id, result) => {
        write({ jsonrpc: '2.0', id, result })
      },
      respondError: (id, code, message) => {
        write({ jsonrpc: '2.0', id, error: { code, message } })
      },
      close
    }
  } catch (error) {
    if (!(await close())) {
      throw new AcpChildExitUnprovenError(error, close)
    }
    throw error
  }
}
