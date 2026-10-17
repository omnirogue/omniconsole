import { attentionCauseLabel } from '@/components/attention/attention-pane-labels'
import type { AttentionPane } from '@/components/attention/agent-pane-snapshot'
import { failureLabel } from '@/components/next-action/up-next-run-labels'
import { translate } from '@/i18n/i18n'
import { backgroundWorkLine } from '@/lib/background-work-wording'
import type { ConversationCompletion } from '@/lib/conversation-retention'
import { sessionChainErrorMessage } from '@/lib/session-chain-error'
import { firstSentence, type SessionRunRowState } from '@/lib/session-run-row-state'
import type { SessionChainRowInfo } from '@/lib/session-chain-runner'
import type { SessionChainSummary } from '@/lib/session-chain-summary'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { describeReturn, hoursUntil } from '@/lib/wait-later'
import type { SessionChain } from '../../../../../shared/session-chain-types'
import { readSessionRun } from '../../../../../shared/session-run-lifecycle'
import { planNeedsYouCaption } from './session-plan-caption'
import type { SessionOwnershipUnverifiedReason } from '../../../../../shared/session-manage-relay'
import {
  sessionOwnershipUnverifiedCaption,
  sessionOwnershipUnverifiedNote
} from '@/lib/session-ownership-verdict'
import { sessionRowCaption } from './session-row-caption'

export type SessionRowStatusInput = {
  activityUnverifiable?: boolean
  /** Its owning computer cannot be verified (quarantined provenance); it stays listed. */
  ownershipUnverified?: SessionOwnershipUnverifiedReason | null
  monitoring?: boolean
  /** Background tasks a monitoring row waits on; absent when the provider gave no count. */
  backgroundTaskCount?: number
  session: SidebarSession
  chain: SessionChainRowInfo | null
  /** The outcome plan this row owns, when it has one. */
  pursuitChain: SessionChain | null
  /** That plan as the one classifier reads it; null on a row without an outcome plan. */
  run: SessionRunRowState | null
  attention: AttentionPane | null
  returned: boolean
  waitingUntil: string | null
  locked: Pick<SessionChainSummary, 'summary' | 'current' | 'placement'> | null
  queued: boolean
  completed: ConversationCompletion | null
  archived: boolean
  now?: number
}

/**
 * The one line a collapsed row shows under its name. Only `ask` and `returned` speak to the
 * person; `failed` is an honest failure whose full diagnostic (`reason`) lives in the details.
 */
export type SessionRowStatus =
  | { kind: 'ask'; text: string; blockedReason: string | null; why?: string }
  | { kind: 'recovering'; text: string }
  | { kind: 'awaiting'; text: string }
  | { kind: 'failed'; text: string; reason: string | null }
  | { kind: 'returned'; text: string }
  | { kind: 'snoozed'; text: string; until: string }
  | { kind: 'queue'; text: string }
  | { kind: 'caption'; text: string; reason: string }
  | { kind: 'locked'; text: string }

/** Why the Up next control refuses this row: a click explains, a hover stays silent. */
export function queueRefusalText(session: SidebarSession): string {
  return session.unavailable
    ? translate(
        'nextStep.queueUnverifiable',
        'This conversation is unverifiable right now. Reconnect to its computer and try again.'
      )
    : translate(
        'nextStep.queueNoPane',
        'There is no live session here to continue. Open it first, then add what comes next.'
      )
}

export { firstSentence } from '@/lib/session-run-row-state'

/** What a queued successor says: ready to start, starting, or how many wait. */
export function queueLineText(chain: SessionChainRowInfo | null): string {
  if (chain?.state === 'ready') {
    return translate(
      'components.sessionChain.readyToStart',
      'Next session ready — click Start next'
    )
  }
  if (chain?.state === 'launching') {
    return translate('components.sessionChain.launching', 'Starting the next session…')
  }
  if (chain && chain.queued > 1) {
    return translate('components.sessionChain.queuedCount', '{{count}} sessions queued', {
      count: chain.queued
    })
  }
  return translate('auto.components.SessionSidebar.nextSessionQueued', 'Next session queued')
}

const OVER = new Set(['failed', 'done', 'cancelled'])

/** A put-away row whose plan is over: it says how it ended, and asks, queues and blocks nothing. */
function isHistory(input: SessionRowStatusInput): boolean {
  if (!input.archived) {
    return false
  }
  return input.run ? input.run.settled : OVER.has(input.chain?.state ?? '')
}

/** The full reason the queue after this row failed, or null when it did not. */
export function sessionRowFailureReason(input: SessionRowStatusInput): string | null {
  const { chain, run, queued, locked } = input
  if (!run && !locked && queued && chain?.state === 'failed') {
    return sessionChainErrorMessage(chain.error)
  }
  return null
}

/** Whether a queued successor has something to say on this row. */
export function showsQueueLine(input: SessionRowStatusInput): boolean {
  const { chain, run, queued, locked } = input
  // Why: a sealed, failed or cancelled run is history; nothing is queued after it any more.
  if (run?.settled) {
    return false
  }
  return !locked && queued && !OVER.has(chain?.state ?? '') && chain?.total !== 0
}

function captionStatus(input: SessionRowStatusInput): SessionRowStatus | null {
  const caption = sessionRowCaption(input.completed, input.archived)
  return caption
    ? { kind: 'caption', text: caption, reason: input.completed?.reason ?? 'archived' }
    : null
}

/**
 * "Failed · The agent stopped responding": the same plain words, by the block's code, as the line
 * under UP NEXT. The host's own sentence is a diagnostic and reads only in the row's details.
 */
function failedRunLine(input: SessionRowStatusInput): string {
  const chain = input.pursuitChain
  const failure = chain?.outcomeSet
    ? readSessionRun(chain.outcomeSet, {
        now: input.now ?? Date.now(),
        planVersion: chain.planVersion
      }).failure
    : undefined
  return failure
    ? translate('conversations.runFailed', 'Failed · {{summary}}', {
        summary: failureLabel(failure.code)
      })
    : translate('conversations.runFailedBare', 'Failed')
}

/** What an outcome run says on its row: its request, then what the host is doing by itself. */
function runStatus(
  run: SessionRunRowState,
  input: SessionRowStatusInput,
  snoozed: boolean
): SessionRowStatus | null {
  switch (run.phase) {
    case 'needs-you':
      // Why: a snoozed row is put away until its time; its own line says when it returns.
      return snoozed
        ? null
        : { kind: 'ask', text: run.headline, blockedReason: null, why: run.detail }
    case 'recovering':
      return { kind: 'recovering', text: run.headline }
    case 'waiting':
      return { kind: 'awaiting', text: run.headline }
    case 'failed':
      return { kind: 'failed', text: failedRunLine(input), reason: run.detail ?? null }
    case 'active':
    case 'completed':
    case 'cancelled':
      return null
  }
}

/**
 * Picks the single status line for a collapsed row: what asks for the person first, then what
 * the host is handling, what failed, what came back, what sleeps, what is queued, what finished,
 * what is locked. A finished or put-away run shows its finished or archived caption and nothing else.
 */
export function sessionRowStatus(input: SessionRowStatusInput): SessionRowStatus | null {
  const { session, chain, run, attention, returned, waitingUntil, locked } = input
  // Why: history asks nothing, queues nothing and blocks nothing; it only says how it ended.
  if (run?.phase === 'completed' && !attention) {
    return captionStatus(input)
  }
  if (isHistory(input)) {
    return captionStatus(input)
  }
  if (!run && chain?.blocked) {
    return {
      kind: 'ask',
      text: planNeedsYouCaption(chain.blocked, chain.blocked.paneKey === session.paneKey),
      blockedReason: chain.blocked.reason
    }
  }
  if (input.ownershipUnverified) {
    return { kind: 'awaiting', text: sessionOwnershipUnverifiedCaption(input.ownershipUnverified) }
  }
  if (input.activityUnverifiable) {
    return {
      kind: 'awaiting',
      text: translate(
        'conversations.activityUnverifiable',
        'Execution unverified · waiting for the host'
      )
    }
  }
  if (input.monitoring && !run) {
    return { kind: 'awaiting', text: backgroundWorkLine(input.backgroundTaskCount) }
  }
  const asked = run ? runStatus(run, input, waitingUntil !== null) : null
  if (asked?.kind === 'ask') {
    return asked
  }
  if (attention) {
    return { kind: 'ask', text: attentionCauseLabel(attention.cause), blockedReason: null }
  }
  if (asked) {
    return asked
  }
  const reason = sessionRowFailureReason(input)
  if (reason !== null) {
    return {
      kind: 'failed',
      text: translate('conversations.runFailed', 'Failed · {{summary}}', {
        summary: firstSentence(reason)
      }),
      reason
    }
  }
  if (returned) {
    return {
      kind: 'returned',
      text: translate('conversations.backToYou', 'Back to you · results ready')
    }
  }
  if (waitingUntil) {
    const now = input.now === undefined ? new Date() : new Date(input.now)
    return {
      kind: 'snoozed',
      until: waitingUntil,
      text: translate('nextStep.snoozedChip', 'Snoozed · returns in {{hours}} h · {{when}}', {
        hours: hoursUntil(new Date(waitingUntil), now),
        when: describeReturn(new Date(waitingUntil), now)
      })
    }
  }
  if (showsQueueLine(input)) {
    return { kind: 'queue', text: queueLineText(chain) }
  }
  const caption = captionStatus(input)
  if (caption) {
    return caption
  }
  if (locked) {
    return { kind: 'locked', text: `🔒 ${locked.summary}` }
  }
  return null
}

/** The notes a collapsed row keeps for its details block, beyond the plan itself. */
export type SessionRowDetailNotes = {
  /** The full diagnostic of a failed queue; an outcome plan prints its own in the plan block. */
  reason: string | null
  /** The queue line, when another status won the row. */
  queue: string | null
  unavailable: string | null
  folderAssignment: string | null
  lock: readonly string[]
}

export function sessionRowDetailNotes(
  input: SessionRowStatusInput,
  status: SessionRowStatus | null
): SessionRowDetailNotes {
  // Why: history keeps only how it ended, so an archived row carries no failure or queue note.
  const history = isHistory(input)
  return {
    reason: history ? null : sessionRowFailureReason(input),
    queue:
      !history && showsQueueLine(input) && status?.kind !== 'queue'
        ? queueLineText(input.chain)
        : null,
    // Why: which computer owns the row is the more specific doubt, so it names that first.
    unavailable: input.ownershipUnverified
      ? sessionOwnershipUnverifiedNote(input.ownershipUnverified)
      : input.session.unavailable
        ? translate(
            'auto.components.SessionSidebar.unverifiable',
            'Unverifiable · reconnect to open'
          )
        : null,
    folderAssignment: input.session.sessionKey
      ? null
      : translate(
          'auto.components.SessionSidebar.folderAssignmentAvailable',
          'Folder assignment is available when the agent identifies this session.'
        ),
    lock: lockLines(input.locked, status)
  }
}

/** The lock's lines for the details block; the summary only when another status won the row. */
function lockLines(
  locked: SessionRowStatusInput['locked'],
  status: SessionRowStatus | null
): readonly string[] {
  if (!locked) {
    return []
  }
  const current = locked.current ? [locked.current] : []
  return status?.kind === 'locked' ? current : [`🔒 ${locked.summary}`, ...current]
}

export function hasSessionRowDetails(
  input: SessionRowStatusInput,
  notes: SessionRowDetailNotes
): boolean {
  return (
    Boolean(input.pursuitChain?.outcomeSet) ||
    notes.reason !== null ||
    notes.queue !== null ||
    notes.unavailable !== null ||
    notes.folderAssignment !== null ||
    notes.lock.length > 0
  )
}
