/**
 * Blank sessions (Sal, 26–27 Sep): an agent that started and that no person ever asked anything.
 * A sibling of Tier 2 with Tier 2's structured vetoes, cleaned up once it has been quiet
 * `emptySessionCloseMinutes` (2 by default), with no result card, because there is nothing to
 * keep. `close` (the default) deletes it the way the sidebar's Delete does: its tab closes, its
 * agent stops, it can be reopened from Recently closed. One whose agent already exited goes at
 * once. `archive` only hides the row and leaves the process running.
 */

import { isSessionManageMarkedPrompt } from '../../shared/session-manage-types'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import {
  emptySessionEvidence,
  STEWARD_EMPTY_SESSION_EVIDENCE,
  STEWARD_EMPTY_SESSION_REASON
} from '../../shared/session-steward-empty-session'
import type { SessionStewardEmptyAction } from '../../shared/session-steward-settings'
import type { StewardTier2Verdict } from '../session-manage/session-manage-unattended-admission'
import type { ObservedSession } from '../session-manage/session-manage-observe'
import { stewardFeatureOn, stewardSettings } from './steward-switches'
import { stewardTier2Blocker, type StewardTier2Input } from './steward-tier2'

export { STEWARD_EMPTY_SESSION_REASON }

/**
 * Whether a person has asked the session anything. `untouched`: this computer saw its agent start
 * fresh and nothing reach it since, not even a keystroke; `none`: its transcript, read whole,
 * holds no prompt; `marked`: only another session's or the steward's marked prompts. Anything
 * this computer cannot read is `unknown`, and an unknown session is never cleaned up.
 */
export type StewardPromptedReading = 'untouched' | 'none' | 'marked' | 'person' | 'unknown'

export type StewardPersonPrompted = (
  row: SessionManageSidebarRow,
  observed: ObservedSession
) => Promise<StewardPromptedReading>

/** Closing ends the agent, so it needs the keystroke-proof reading; an archive takes any empty one. */
export function isBlankReading(
  reading: StewardPromptedReading,
  action: SessionStewardEmptyAction
): boolean {
  return (
    reading === 'untouched' ||
    (action === 'archive' && (reading === 'none' || reading === 'marked'))
  )
}

/**
 * `prompts`: every prompt this computer saw reach it (the agent's latest hook report, and its
 * transcript's first prompt and kept user turns); `complete`: the transcript was read whole and
 * none of its turns fell out of view. Marked prompts are another session's or the steward's words.
 */
export function stewardPromptedReading(input: {
  prompts: readonly (string | null | undefined)[]
  complete: boolean
}): Exclude<StewardPromptedReading, 'untouched'> {
  const said = input.prompts.map((prompt) => prompt?.trim() ?? '').filter(Boolean)
  if (said.some((prompt) => !isSessionManageMarkedPrompt(prompt))) {
    return 'person'
  }
  if (!input.complete) {
    return 'unknown'
  }
  return said.length > 0 ? 'marked' : 'none'
}

function minutes(ms: number): string {
  return `${Math.floor(Math.max(0, ms) / 60_000)} min`
}

/** The blank-session rule over Tier 2's reading, with this computer's timeout and action. */
export async function stewardEmptySessionCheck(
  deps: { personPrompted?: StewardPersonPrompted },
  input: StewardTier2Input,
  row: SessionManageSidebarRow,
  observed: ObservedSession,
  action: SessionStewardEmptyAction
): Promise<StewardTier2Verdict> {
  if (!stewardFeatureOn('emptySessionArchive')) {
    return { ok: false, reason: 'the blank-session rule is switched off' }
  }
  const prompted = deps.personPrompted
    ? await deps.personPrompted(row, observed).catch((): StewardPromptedReading => 'unknown')
    : 'unknown'
  return stewardEmptySessionVouched(
    row,
    stewardEmptySessionVerdict({
      ...input,
      prompted,
      quietMs: stewardSettings().emptySessionCloseMinutes * 60_000,
      action,
      agentForeground: observed.agentForeground,
      lastSeenAt: row.lastSeenAt ?? null
    })
  )
}

/**
 * The window re-reads the row's idle-and-unprompted revision just before filing or closing, so a
 * prompt, keystroke or look that lands after this judgment refuses it there; a window that cannot
 * vouch never cleans anything up.
 */
export function stewardEmptySessionVouched(
  row: Pick<SessionManageSidebarRow, 'viewKey' | 'emptyArchiveRevision'>,
  verdict: StewardTier2Verdict
): StewardTier2Verdict {
  if (!verdict.ok) {
    return verdict
  }
  if (!row.emptyArchiveRevision) {
    return {
      ok: false,
      reason:
        'a person started it, or the window does not show it idle and unprompted, or it is on screen'
    }
  }
  return {
    ok: true,
    evidence: `${verdict.evidence}; ${emptySessionEvidence(row.viewKey, row.emptyArchiveRevision)}`
  }
}

export type StewardEmptySessionInput = Omit<StewardTier2Input, 'jevOff' | 'doneness'> & {
  prompted: StewardPromptedReading
  quietMs: number
  action: SessionStewardEmptyAction
  /** The process table proves its own agent holds its terminal (`ObservedSession`). */
  agentForeground: boolean | null
  /** When its tab was last on screen in this window run: the quiet clock restarts from it. */
  lastSeenAt: number | null
}

/**
 * Tier 2's vetoes, then: nobody asked it anything, and either its agent exited (no wait) or it
 * sits at its prompt, quiet long enough. An agent at its fresh start that shows no idle marker
 * yet counts as at its prompt only on the untouched proof with its own process holding the
 * terminal; working, queued or asking never does.
 */
export function stewardEmptySessionVerdict(input: StewardEmptySessionInput): StewardTier2Verdict {
  const { entry, prompted, action } = input
  const exited = entry.verdict === 'exited'
  const atStart =
    entry.verdict === 'live' &&
    entry.state === 'unknown' &&
    prompted === 'untouched' &&
    input.agentForeground === true
  const lastActivityAt =
    input.lastActivityAt === null ? null : Math.max(input.lastActivityAt, input.lastSeenAt ?? 0)
  const blocker = stewardTier2Blocker(
    { ...input, lastActivityAt },
    {
      ms: exited ? 0 : input.quietMs,
      needs: `a blank session is ${action === 'close' ? 'closed' : 'archived'} after ${minutes(input.quietMs)}`,
      unknownIsIdle: atStart,
      // Why close only: on a connected SSH host the relay ends the pane; an archive there is not ours.
      sshLive: action === 'close'
    }
  )
  if (blocker) {
    return { ok: false, reason: blocker }
  }
  if (!exited && !(entry.verdict === 'live' && (entry.state === 'idle' || atStart))) {
    return { ok: false, reason: `it is ${entry.state}, not idle at its prompt` }
  }
  if (prompted === 'person') {
    return { ok: false, reason: 'a person has asked it something' }
  }
  if (!isBlankReading(prompted, action)) {
    return {
      ok: false,
      reason:
        prompted === 'marked'
          ? 'another session or the steward has asked it something'
          : prompted === 'none'
            ? 'this computer has no record that nothing, not even a keystroke, reached it since it started'
            : 'this computer cannot tell whether a person has asked it anything'
    }
  }
  // Why name the queue: the blocker above refused any queued or held prompt, and the recheck at
  // the settle boundary reads these again, so the proof states what it was granted on.
  return {
    ok: true,
    evidence: `${STEWARD_EMPTY_SESSION_EVIDENCE} · ${exited ? 'its agent exited' : `idle ${minutes(input.now - lastActivityAt!)}`} · queue empty · nothing held`
  }
}
