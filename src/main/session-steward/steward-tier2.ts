import { doneArchiveDue } from '../../shared/session-done-archive'
/**
 * Tier 2 (D3): whether the steward may archive a session as "finished, not verified". Every rule
 * must hold, in this order, and anything structured that says the work is unfinished outweighs
 * any JEV reading. A result card must also be saved first (`steward-tier2-check.ts`).
 */

import { parseExecutionHostId } from '../../shared/execution-host'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import type { SessionManageEntry } from '../../shared/session-manage-types'
import { remoteExecutionRefusal } from '../session-manage/session-manage-locality'
import { stewardDonenessVerdict, type StewardDoneness } from './steward-jev'

export const STEWARD_TIER2_QUIET_MS = 2 * 60 * 60_000

export type StewardTier2Input = {
  row: Pick<SessionManageSidebarRow, 'hostUnavailable' | 'launchPending' | 'doneArchivePolicy'> & {
    autoArchiveKeep?: boolean
  }
  entry: SessionManageEntry
  /** `sessionTidyHoldReason`: an open recorded commitment, attempt, quarantine, review… */
  hold: string | null
  waitedOnBy: readonly string[]
  heldDelivery: boolean
  /** The latest activity by anyone, the agent or the person; null when none is known. */
  lastActivityAt: number | null
  now: number
  jevOff: string | null
  /** JEV's reading of its latest turn; null when there is none. */
  doneness: StewardDoneness | null
}

export type StewardTier2Verdict = { ok: true; evidence: string } | { ok: false; reason: string }

const no = (reason: string): StewardTier2Verdict => ({ ok: false, reason })

/** Round down so the display never claims a delay has elapsed early. */
function hours(ms: number): string {
  const value = ms / 3_600_000
  return `${value >= 10 ? Math.floor(value) : Math.floor(value * 10) / 10} h`
}

function openWork(
  input: Pick<StewardTier2Input, 'entry' | 'heldDelivery'>,
  unknownIsIdle = false
): string | null {
  const { entry } = input
  if (entry.state === 'awaiting-user' || entry.ask) {
    return 'it is asking the person something'
  }
  if (entry.queueLength > 0) {
    return 'it has prompts waiting in its queue'
  }
  if (entry.pendingSteps.length > 0) {
    return 'it has its own next steps waiting'
  }
  // Why not for exited: its waitingOn only says how it ended; for an unknown state the blank
  // rule reads as idle, it only says why the state is unknown.
  const notAWait = entry.verdict === 'exited' || (unknownIsIdle && entry.state === 'unknown')
  if (entry.waitingOn && !notAWait) {
    return `it is waiting on something (${entry.waitingOn.replace(/\.$/, '')})`
  }
  return input.heldDelivery ? 'a held prompt is waiting to be sent to it' : null
}

/**
 * How long a session must be quiet, and how its refusal names that rule. `unknownIsIdle`: the
 * blank-session rule's own proof that the agent sits at its first prompt stands in for idle.
 * `sshLive`: its close of a pane on a connected SSH host, which the relay ends there.
 */
export type StewardQuietRule = {
  ms: number
  needs: string
  unknownIsIdle?: boolean
  sshLive?: boolean
}

/**
 * The first rule before JEV's that fails, or null when they all hold. Without a `quietRule` the
 * session must have been continuously Done for its configured delay (Tier 2); a sibling rule such
 * as empty sessions passes its own plain quiet period instead.
 */
export function stewardTier2Blocker(
  input: Omit<StewardTier2Input, 'jevOff' | 'doneness'>,
  quietRule?: StewardQuietRule
): string | null {
  const { entry, row } = input
  if (entry.archived) {
    return 'it is already archived'
  }
  const remote = remoteExecutionRefusal(entry, 'archive')
  const sshLive =
    quietRule?.sshLive === true &&
    parseExecutionHostId(entry.hostId)?.kind === 'ssh' &&
    !row.hostUnavailable &&
    entry.verdict === 'live'
  if (remote && !sshLive) {
    return remote
  }
  if (row.hostUnavailable || entry.verdict === 'unverifiable') {
    return 'this computer cannot see it, and that is never read as finished'
  }
  if (row.launchPending || !entry.paneKey) {
    return 'its launch is still pending'
  }
  const finishedState =
    entry.verdict === 'exited' ||
    (entry.verdict === 'live' &&
      (entry.state === 'idle' || (quietRule?.unknownIsIdle === true && entry.state === 'unknown')))
  if (!finishedState) {
    return `it is ${entry.state}, not idle or exited`
  }
  const open = openWork(input, quietRule?.unknownIsIdle === true)
  if (open) {
    return open
  }
  if (input.hold) {
    return input.hold.replace(/\.$/, '').replace(/^Its/, 'its')
  }
  if (input.waitedOnBy.length > 0) {
    return 'another session is waiting on its result'
  }
  if (entry.pinned) {
    return 'it is pinned'
  }
  if (entry.saved) {
    return 'it is saved'
  }
  if (row.autoArchiveKeep) {
    return 'the person brought it back from the archive'
  }
  if (input.lastActivityAt === null) {
    return 'its last activity is unknown, and that is never read as quiet'
  }
  if (quietRule) {
    const quiet = input.now - input.lastActivityAt
    return quiet < quietRule.ms
      ? `it has been quiet for ${hours(Math.max(0, quiet))}; ${quietRule.needs}`
      : null
  }
  if (!input.row.doneArchivePolicy) {
    return 'its continuous Done clock is absent, disabled or blocked by attention'
  }
  const quiet = input.now - Math.max(input.lastActivityAt, input.row.doneArchivePolicy.since)
  return !doneArchiveDue(input.row.doneArchivePolicy, input.now) ||
    quiet < input.row.doneArchivePolicy.delayMs
    ? `it has been quiet for ${hours(Math.max(0, quiet))}; the Done delay has not elapsed`
    : null
}

export function stewardTier2Verdict(input: StewardTier2Input): StewardTier2Verdict {
  const blocker = stewardTier2Blocker(input)
  if (blocker) {
    return no(blocker)
  }
  if (input.jevOff) {
    return no(input.jevOff)
  }
  if (!input.doneness) {
    return no('JEV has no reading of its latest turn')
  }
  if (stewardDonenessVerdict(input.doneness) !== 'finished') {
    return no(
      `JEV does not read it as finished (resolved ${input.doneness.resolved.toFixed(2)}, work left ${input.doneness.remainingWork.toFixed(2)})`
    )
  }
  const quiet = input.now - input.lastActivityAt!
  return {
    ok: true,
    evidence: `JEV resolved ${input.doneness.resolved.toFixed(2)} · quiet ${hours(quiet)}`
  }
}

const usable = (time: number | null | undefined): time is number =>
  typeof time === 'number' && Number.isFinite(time) && time > 0

/**
 * When a session last moved, by its agent or the person. Null when the agent's own last activity
 * is unknown: a person's later touch cannot make an unknown clock quiet.
 */
export function stewardLastActivityAt(
  agentAt: number | null | undefined,
  ...others: readonly (number | null | undefined)[]
): number | null {
  return usable(agentAt) ? Math.max(agentAt, ...others.filter(usable)) : null
}
