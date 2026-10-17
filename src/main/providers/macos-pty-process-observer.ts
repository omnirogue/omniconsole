import type { Readable } from 'node:stream'
import { spawnProcess } from '../../shared/child-process/run-process'
import { resolveMacosPtyProcessObserver } from './macos-pty-process-observer-path'

export type MacosObservedPtyProcess = {
  pid: number
  processStartTimeMs: number
  ptyRootPid: number
  ptyRootProcessStartTimeMs: number
}

export type MacosPtyProcessObservation =
  | { state: 'live'; source: 'macos-kqueue' }
  | { state: 'unverifiable'; reason: string }
  | {
      state: 'exited'
      source: 'macos-kqueue'
      waitStatus: number
      exitCode: number | null
      signal: number | null
      observedAtMs: number
    }

const positiveInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0

export type MacosPtyProcessObserver = {
  identity: MacosObservedPtyProcess
  verifyHeld(): Promise<void>
  read(): Promise<MacosPtyProcessObservation>
  dispose(): void
}

export async function armMacosPtyProcessObserver(args: {
  rootPid: number
  shellPid: number
  shellPath: string
}): Promise<MacosPtyProcessObserver> {
  const executable = resolveMacosPtyProcessObserver()
  if (!executable) {
    throw new Error('pty_launch_gate_exit_observer_unavailable')
  }
  const child = spawnProcess({
    program: executable,
    args: [String(args.rootPid), String(args.shellPid), args.shellPath],
    stdio: ['pipe', 'ignore', 'ignore', 'pipe']
  })
  const receipts = child.stdio[3] as Readable
  const armed = Promise.withResolvers<MacosObservedPtyProcess>()
  let identity: MacosObservedPtyProcess | undefined
  let observation: MacosPtyProcessObservation = {
    state: 'unverifiable',
    reason: 'observer_not_armed'
  }
  let pending: { resolve: () => void; reject: (error: Error) => void }[] = []
  let input = ''
  let ended = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const fail = (reason: string): void => {
    if (
      observation.state === 'live' ||
      (observation.state === 'unverifiable' && observation.reason === 'observer_not_armed')
    ) {
      observation = { state: 'unverifiable', reason }
    }
    const error = new Error(`pty_launch_gate_${reason}`)
    armed.reject(error)
    for (const request of pending) {
      request.reject(error)
    }
    pending = []
    clearTimeout(timer)
  }
  const dispose = (): void => {
    if (ended) {
      return
    }
    ended = true
    fail('exit_observer_closed')
    child.stdin.end()
  }
  child.on('error', () => {
    fail('exit_observer_failed')
    dispose()
  })
  child.on('close', () => {
    ended = true
    fail('exit_observer_lost')
  })
  child.stdin.on('error', () => {
    fail('exit_observer_failed')
    dispose()
  })
  receipts.on('error', () => {
    fail('exit_observer_failed')
    dispose()
  })
  receipts.on('data', (chunk: Buffer | string) => {
    input += chunk.toString()
    if (input.length > 4096) {
      fail('exit_observer_protocol_invalid')
      dispose()
      return
    }
    let boundary: number
    while ((boundary = input.indexOf('\n')) >= 0) {
      const line = input.slice(0, boundary)
      input = input.slice(boundary + 1)
      try {
        const message = JSON.parse(line) as Record<string, unknown>
        if (
          message.event === 'armed' &&
          !identity &&
          positiveInteger(message.pid) &&
          message.pid === args.shellPid &&
          message.ptyRootPid === args.rootPid &&
          positiveInteger(message.processStartTimeMs) &&
          positiveInteger(message.ptyRootProcessStartTimeMs)
        ) {
          identity = {
            pid: message.pid,
            processStartTimeMs: message.processStartTimeMs,
            ptyRootPid: args.rootPid,
            ptyRootProcessStartTimeMs: message.ptyRootProcessStartTimeMs
          }
          observation = { state: 'live', source: 'macos-kqueue' }
          armed.resolve(identity)
        } else if (
          message.event === 'checked' &&
          identity &&
          pending.length &&
          observation.state === 'live'
        ) {
          const request = pending.shift()!
          if (message.verified === true) {
            request.resolve()
          } else {
            request.reject(new Error('pty_launch_gate_identity_unverifiable'))
          }
        } else if (
          message.event === 'exited' &&
          identity &&
          message.pid === identity.pid &&
          message.processStartTimeMs === identity.processStartTimeMs &&
          positiveInteger(message.observedAtMs) &&
          Number.isSafeInteger(message.waitStatus) &&
          (message.waitStatus as number) >= 0 &&
          (message.waitStatus as number) <= 65535 &&
          Number.isSafeInteger(message.exitCode) &&
          Number.isSafeInteger(message.signal) &&
          (((message.exitCode as number) >= 0 &&
            (message.exitCode as number) <= 255 &&
            message.signal === 0 &&
            ((message.waitStatus as number) & 127) === 0 &&
            (((message.waitStatus as number) >> 8) & 255) === message.exitCode) ||
            (message.exitCode === -1 &&
              (message.signal as number) > 0 &&
              (message.signal as number) < 127 &&
              ((message.waitStatus as number) & 127) === message.signal))
        ) {
          observation = {
            state: 'exited',
            source: 'macos-kqueue',
            waitStatus: message.waitStatus as number,
            exitCode: message.exitCode === -1 ? null : (message.exitCode as number),
            signal: message.signal === 0 ? null : (message.signal as number),
            observedAtMs: message.observedAtMs
          }
          fail('registered_process_exited')
        } else if (message.event === 'unverifiable' && typeof message.reason === 'string') {
          fail(message.reason)
          dispose()
        } else {
          fail('exit_observer_protocol_invalid')
          dispose()
        }
      } catch {
        fail('exit_observer_protocol_invalid')
        dispose()
      }
    }
  })
  timer = setTimeout(() => {
    fail('exit_observer_timeout')
    dispose()
  }, 5000)
  let prepared: MacosObservedPtyProcess
  try {
    prepared = await armed.promise
  } finally {
    clearTimeout(timer)
  }

  const check = async (held: boolean): Promise<void> => {
    if (observation.state !== 'live' || ended) {
      throw new Error('pty_launch_gate_identity_unverifiable')
    }
    const request = Promise.withResolvers<void>()
    pending.push(request)
    child.stdin.write(held ? 'verify-held\n' : 'check\n')
    const deadline = setTimeout(() => {
      fail('exit_observer_timeout')
      dispose()
    }, 5000)
    try {
      await request.promise
    } finally {
      clearTimeout(deadline)
    }
  }
  return {
    identity: prepared,
    verifyHeld: () => check(true),
    read: async () => {
      if (observation.state === 'live') {
        try {
          await check(false)
        } catch {
          if (observation.state === 'live') {
            return { state: 'unverifiable', reason: 'registered_process_identity_unverifiable' }
          }
        }
      }
      return { ...observation }
    },
    dispose
  }
}
