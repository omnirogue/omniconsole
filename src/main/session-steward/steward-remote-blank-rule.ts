/**
 * The blank-session rules for sessions an SSH host runs (Sal, 27 Sep), as pure readings. While
 * the host is connected a blank pane is closed like a local one, and the relay ends it there. A
 * blank row whose host this computer has not reached for a day is only archived here (the third
 * rule): its remote process is never claimed stopped, and once the host is back the live rule
 * closes it. A session another OmniConsole runs is that computer's own steward's.
 */

import { parseExecutionHostId } from '../../shared/execution-host'
import { isJunkSessionTitle } from '../../shared/session-junk-title'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import type { SessionManageEntry } from '../../shared/session-manage-types'
import {
  STEWARD_UNREACHABLE_BLANK_EVIDENCE,
  UNREACHABLE_BLANK_ARCHIVE_MS,
  unreachableBlankEvidence,
  unreachableBlankReachMarker,
  unreachableBlankRowMarker
} from '../../shared/session-steward-unreachable-blank'
import type { StewardTier2Verdict } from '../session-manage/session-manage-unattended-admission'
import type { StewardDrivers } from './steward-rules'
import type { StewardTier2Input } from './steward-tier2'

type HostRow = Pick<SessionManageSidebarRow, 'hostId' | 'hostUnavailable'>

function sshHost(row: Pick<SessionManageSidebarRow, 'hostId'>): boolean {
  return parseExecutionHostId(row.hostId)?.kind === 'ssh'
}

/** A pane on a connected SSH host: the blank rule may close it, and the relay ends it there. */
export function isLiveSshRow(row: HostRow): boolean {
  return sshHost(row) && !row.hostUnavailable
}

/** A row whose SSH host this computer cannot reach now (the third rule's candidates). */
export function isUnreachableSshRow(row: HostRow): boolean {
  return sshHost(row) && row.hostUnavailable
}

/** An SSH row the rules loop's skip holds for being remote, that only the blank rules may read. */
export function isRemoteBlankCandidate(
  row: HostRow & Pick<SessionManageSidebarRow, 'launchPending'>,
  entry: SessionManageEntry,
  drivers: StewardDrivers
): boolean {
  return (
    sshHost(row) &&
    !entry.archived &&
    !entry.pinned &&
    !entry.keepGoing &&
    !row.launchPending &&
    !drivers.chainBound &&
    !drivers.heldDelivery &&
    (row.hostUnavailable
      ? entry.verdict === 'unverifiable'
      : entry.verdict === 'live' && (entry.state === 'idle' || entry.state === 'unknown'))
  )
}

export type StewardLastHookRow = {
  prompt?: string
  sessionBoundary?: boolean
  lastAssistantMessage?: string
  interactivePrompt?: string
}

function unreachableBlocker(
  row: SessionManageSidebarRow,
  input: Omit<StewardTier2Input, 'jevOff' | 'doneness'>,
  hook: StewardLastHookRow | null,
  queued: number,
  filed: boolean
): string | null {
  const { entry } = input
  const checks: [boolean, string][] = [
    [
      !isUnreachableSshRow(row) || entry.verdict !== 'unverifiable',
      'its SSH host is reachable now, so the live blank rule decides'
    ],
    [entry.archived && !filed, 'it is already archived'],
    [
      entry.pinned || entry.saved || row.autoArchiveKeep === true,
      'it is pinned, saved or was brought back by the person'
    ],
    [
      input.hold !== null || input.waitedOnBy.length > 0 || input.heldDelivery,
      'something holds it or waits on it'
    ],
    // Why read here: a host that cannot be reached shows no queue in its observation.
    [queued > 0 || row.launchPending, 'prompts wait in its queue, or its launch is pending'],
    [!!(row.providerSessionId || row.transcriptPath), 'its agent reported a conversation'],
    [!isJunkSessionTitle(row.title), 'it has a title of its own'],
    [
      !hook ||
        !!hook.prompt?.trim() ||
        hook.sessionBoundary !== true ||
        !!hook.lastAssistantMessage ||
        !!hook.interactivePrompt,
      'its last report is not its agent’s empty start'
    ]
  ]
  return checks.find(([fails]) => fails)?.[1] ?? null
}

/**
 * The third rule over what this computer holds for an unreachable SSH row: nothing held or
 * waiting, no provider conversation, a launcher's title, a last hook report that is still its
 * agent's empty start, and the window's clock at a day or more. `recheck` (after the window
 * filed it) re-reads the facts only: its clock and revision are gone once the row is archived.
 */
export function stewardUnreachableBlankVerdict(args: {
  row: SessionManageSidebarRow
  input: Omit<StewardTier2Input, 'jevOff' | 'doneness'>
  hook: StewardLastHookRow | null
  /** Prompts waiting in its queue (its observation cannot show them). */
  queued: number
  /** When this computer last had its host connected; a later reconnect restarts the day. */
  lastReachedAt: number | null
  recheck?: { granted: string }
}): StewardTier2Verdict {
  const { row, input, recheck } = args
  const blocker = unreachableBlocker(row, input, args.hook, args.queued, recheck !== undefined)
  if (blocker) {
    return { ok: false, reason: blocker }
  }
  const marker = unreachableBlankRowMarker(row.viewKey)
  const reach = unreachableBlankReachMarker(args.lastReachedAt)
  if (recheck) {
    const { granted } = recheck
    // Why all three: only this rule's grant, for this row, with its host unreached since.
    if (!granted.includes(STEWARD_UNREACHABLE_BLANK_EVIDENCE) || !granted.includes(marker)) {
      return {
        ok: false,
        reason: 'the grant was not the unreachable-blank rule’s for this session'
      }
    }
    return granted.includes(`${reach};`)
      ? { ok: true, evidence: granted }
      : { ok: false, reason: 'its host was reached after it was archived' }
  }
  const revision = row.unreachableBlankRevision
  const clock = row.unreachableBlankPolicy
  if (!revision || clock?.revision !== revision) {
    return { ok: false, reason: 'the window does not show it blank on an unreachable host' }
  }
  const since = Math.max(clock.since, args.lastReachedAt ?? Number.NEGATIVE_INFINITY)
  const hours = Math.floor(Math.max(0, input.now - since) / 3_600_000)
  if (input.now - since < UNREACHABLE_BLANK_ARCHIVE_MS) {
    return { ok: false, reason: `its host has been unreachable ${hours} h; the rule waits a day` }
  }
  return {
    ok: true,
    evidence: `${STEWARD_UNREACHABLE_BLANK_EVIDENCE} · unreachable ${hours} h · no prompt · ${marker} · ${reach}; ${unreachableBlankEvidence(row.viewKey, revision)}`
  }
}
