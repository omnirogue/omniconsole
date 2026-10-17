/**
 * Tells OmniOS where each review's publishing session is (waiting, asleep, waking, awake, deleted,
 * stalled) and that this computer is online, so Work → Decisions shows it (CONTRACT.md, OAOS-12).
 * Each state is sent once per change; a server without the endpoints is left alone for 30 minutes
 * and the desktop keeps its own view. Nothing here carries a transcript, path or credential.
 */

import { runProcess } from '../../shared/child-process/run-process'
import { localHostLabel } from '../local-host-label'
import { OrcaCloudRequestError } from '../omni-profiles/profile-cloud-client'
import type { ArtifactReviewSleep } from '../../shared/artifact-review-sleep'
import type { ReviewSleepEntry } from './artifact-review-sleep-targets'

/** `refused`: a coded answer (page gone, clock far ahead) that the next minute would repeat. */
export type SourceStatePost = (
  path: string,
  body: unknown
) => Promise<'ok' | 'unsupported' | 'refused' | 'failed'>

export const SOURCE_STATE_REPORT_WINDOW_MS = 7 * 24 * 60 * 60_000
const UNSUPPORTED_BACKOFF_MS = 30 * 60_000
const OPEN_STATES = new Set(['waiting', 'asleep', 'waking', 'stalled'])

export function sourceStateResult(error: unknown): 'unsupported' | 'refused' | 'failed' {
  if (!(error instanceof OrcaCloudRequestError)) {
    return 'failed'
  }
  // A route an older server lacks answers 404 with no code (or 405), never `artifact_not_found`.
  if (error.statusCode === 405 || (error.statusCode === 404 && !error.errorCode)) {
    return 'unsupported'
  }
  // Why `invalid_at` retries: a clock a few minutes fast is accepted once it is corrected.
  const final =
    error.statusCode >= 400 &&
    error.statusCode < 500 &&
    error.statusCode !== 408 &&
    error.statusCode !== 429 &&
    Boolean(error.errorCode) &&
    error.errorCode !== 'invalid_at'
  return final ? 'refused' : 'failed'
}

let computerName: Promise<string> | null = null

/** "Sal's MacBook Pro" on a Mac (its sharing name), else the host name without its domain. */
export function reviewHostLabel(): Promise<string> {
  computerName ??=
    process.platform === 'darwin'
      ? runProcess({ program: 'scutil', args: ['--get', 'ComputerName'], timeoutMs: 3_000 })
          .then((result) => (result.code === 0 && result.stdout.trim()) || localHostLabel())
          .catch(() => localHostLabel())
      : Promise.resolve(localHostLabel().split('.')[0] || 'this computer')
  return computerName
}

/**
 * The reason OmniOS may show: one of a few fixed words, never an account, path or error text
 * (the page's audience can read it). The full reason stays in this computer's own record.
 */
export function publicSourceReason(sleep: ArtifactReviewSleep): string | undefined {
  const reason = sleep.reason ?? ''
  if (reason.startsWith('capacity:')) {
    return reason.includes('signed out') ? 'account signed out' : 'capacity'
  }
  if (reason.includes('window opens')) {
    return 'window closed'
  }
  if (reason.includes('can be verified')) {
    return 'could not verify'
  }
  if (sleep.state !== 'stalled') {
    return undefined
  }
  if (reason.includes('waits on page')) {
    return 'kept: another page open'
  }
  // A Reject that kept the session ("Rejected; …") is a keep, never a failure to start; a
  // "Rejected · …" note on a wait that was already stalled says nothing new.
  if (reason.startsWith('Rejected; ')) {
    return 'kept: protected'
  }
  if (reason.startsWith('Rejected') || reason.startsWith('Moved to')) {
    return undefined
  }
  return 'could not start'
}

/** Phase 2: whether another computer can wake it (a copy is up), and if not, why not. */
export function wakeCopyReport(sleep: ArtifactReviewSleep): {
  portable: boolean | null
  reason?: string
} {
  const copy = sleep.wakeCopy?.revision === sleep.revision ? sleep.wakeCopy : undefined
  const portable = sleep.state !== 'asleep' || !copy ? null : Boolean(copy.sha256)
  const reason = portable === false && copy?.refused ? copy.refused : publicSourceReason(sleep)
  return { portable, ...(reason ? { reason } : {}) }
}

export function createSourceStateReporter(deps: {
  entries(): ReviewSleepEntry[]
  host(): Promise<{ hostId: string; host: string } | null>
  /** Only a computer with a window can wake its sleeping sessions, so only it says it is there. */
  windowAttached(): boolean
  post: SourceStatePost
  now(): number
}): { heartbeat(): Promise<void>; states(): Promise<void> } {
  // Keyed by share record: two records of one page must not overwrite each other's signature.
  const reported = new Map<string, string>()
  let unsupportedUntil = 0
  const recent = (now: number): ReviewSleepEntry[] =>
    deps.entries().filter((entry) => now - entry.sleep.at <= SOURCE_STATE_REPORT_WINDOW_MS)
  // Why before and after the delivery pass: a slow pass must not leave OmniOS 120 s without one.
  // Why only with an open wait and a window: a quit computer cannot wake anything; age does not
  // matter, since a decision a week late still wakes the session here.
  const heartbeat = async (): Promise<void> => {
    const now = deps.now()
    if (
      now < unsupportedUntil ||
      !deps.windowAttached() ||
      !deps.entries().some((entry) => OPEN_STATES.has(entry.sleep.state))
    ) {
      return
    }
    const host = await deps.host()
    if (!host) {
      return
    }
    const beat = await deps.post('/source-heartbeat', {
      hostId: host.hostId,
      host: host.host.slice(0, 120)
    })
    if (beat === 'unsupported') {
      unsupportedUntil = now + UNSUPPORTED_BACKOFF_MS
    }
  }
  const states = async (): Promise<void> => {
    const now = deps.now()
    const entries = now < unsupportedUntil ? [] : recent(now)
    const host = entries.length ? await deps.host() : null
    if (!host) {
      return
    }
    for (const entry of entries) {
      // Why not `moved`: OmniOS already shows the claim's host; this one would overwrite it.
      if (entry.sleep.state === 'moved') {
        continue
      }
      const body = {
        state: entry.sleep.state,
        revision: entry.sleep.revision,
        hostId: host.hostId,
        host: host.host.slice(0, 120),
        at: new Date(entry.sleep.at).toISOString(),
        ...wakeCopyReport(entry.sleep)
      }
      const signature = JSON.stringify(body)
      if (reported.get(entry.sourceKey) === signature) {
        continue
      }
      const result = await deps.post(`/${encodeURIComponent(entry.slug)}/source-state`, body)
      if (result === 'unsupported') {
        unsupportedUntil = now + UNSUPPORTED_BACKOFF_MS
        return
      }
      if (result === 'ok' || result === 'refused') {
        reported.set(entry.sourceKey, signature)
      }
    }
    await heartbeat()
  }
  return { heartbeat, states }
}
