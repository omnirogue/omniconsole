import {
  isAgentForegroundWrapperProcess,
  recognizeAgentProcess
} from '../../shared/agent-process-recognition'
import { resolveAgentForegroundProcessWithAvailability } from '../providers/agent-foreground-process'
import type { SessionInfo } from './types'

type SessionOwner = Pick<
  SessionInfo,
  'sessionId' | 'incarnationId' | 'pid' | 'createdAt' | 'isAlive' | 'wslDistro'
>

// An adopted PTY worker can predate the app's interpreter recognition rules.
export async function resolveDaemonWrapperForeground(input: {
  sessionId: string
  incarnationId: string | undefined
  foregroundProcess: string | null
  readSession: () => Promise<SessionOwner | undefined>
  isCurrent: () => boolean
}): Promise<{ available: boolean; processName: string | null }> {
  const fallback = { available: true, processName: input.foregroundProcess }
  if (!isAgentForegroundWrapperProcess(input.foregroundProcess)) {
    return fallback
  }
  const unavailable = { ...fallback, available: false }
  if (!input.incarnationId || !input.isCurrent()) {
    return unavailable
  }
  try {
    const before = await input.readSession()
    if (
      !input.isCurrent() ||
      before?.sessionId !== input.sessionId ||
      before.incarnationId !== input.incarnationId ||
      !before.isAlive ||
      !before.pid ||
      before.wslDistro
    ) {
      return unavailable
    }
    const resolved = await resolveAgentForegroundProcessWithAvailability(
      before.pid,
      input.foregroundProcess,
      { fresh: true, forceProcessScan: true }
    )
    if (!resolved.available || !input.isCurrent()) {
      return unavailable
    }
    const after = await input.readSession()
    if (
      !input.isCurrent() ||
      after?.sessionId !== before.sessionId ||
      after.incarnationId !== before.incarnationId ||
      after.pid !== before.pid ||
      after.createdAt !== before.createdAt ||
      !after.isAlive ||
      after.wslDistro
    ) {
      return unavailable
    }
    // A generic wrapper remaining unknown does not prove its agent has exited.
    return recognizeAgentProcess(resolved.processName) ? resolved : fallback
  } catch {
    return unavailable
  }
}
