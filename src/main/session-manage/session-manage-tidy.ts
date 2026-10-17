/**
 * `omni session tidy`: the omni-sessions skill's one cleanup rule, as a plan over every sidebar
 * conversation. Archive only what is `exited`, or `idle` with nothing pending, queued or waiting on
 * the person; hold what has an unfinished recorded commitment; skip everything else. It runs only
 * when the person asks, and archive (reversible, with Undo) is the only change it ever makes.
 */

import { parseExecutionHostId } from '../../shared/execution-host'
import { isLiveSessionChain, type SessionChain } from '../../shared/session-chain-types'
import {
  sessionCommitmentProof,
  sessionStillNeedsOwnerReview
} from '../../shared/session-archive-proof'
import { isJunkSessionTitle } from '../../shared/session-junk-title'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import type {
  SessionManageEntry,
  SessionManageState,
  SessionTidyAction,
  SessionTidyGroup,
  SessionTidyResult,
  SessionTidyRow
} from '../../shared/session-manage-types'
import { addressesConversation } from '../runtime/conversation-chain-ownership'
import { isFinishedOutcomeChain } from '../runtime/session-outcome-source-uniqueness'
import { remoteExecutionRefusal } from './session-manage-locality'
import { classifySessionTidyDelete } from './session-manage-tidy-delete'
import { classifyWorkflowSessionTidy } from './session-manage-workflow'
import { sessionWorkflowAnchorRef } from '../../shared/session-workflow-anchor'

type TidyRowInput = Pick<
  SessionManageSidebarRow,
  | 'rowKey'
  | 'paneKey'
  | 'worktreeId'
  | 'hostUnavailable'
  | 'launchPending'
  | 'routine'
  | 'workflow'
  | 'strandedMirrorRecord'
  | 'providerSessionId'
>

export type SessionTidyVerdict = {
  action: SessionTidyAction
  reason: string
  group?: SessionTidyGroup
  included?: true
  /** Delete mode: this computer runs it but cannot verify it, so it goes only with --unverified. */
  unverified?: true
}

/** Archive (the default), or delete what qualifies (`--delete`, with `--unverified`). */
export type SessionTidyMode = {
  delete?: boolean
  unverified?: boolean
  /** Delete mode: the session running the cleanup, which never deletes itself. */
  selfPaneKey?: string
  /** Its tab: a delete closes the whole tab, so a split beside the caller is kept too. */
  selfTabId?: string
  /** Delete mode's clock, for "active in the last hour". */
  now?: number
  /** Why a review decision or a Question still waits on it (`answer-wait.ts`); such a row is kept. */
  answerWait?: (row: TidyRowInput) => string | null
}

const BUSY_STATE_WORDS: Partial<Record<SessionManageState, string>> = {
  working: 'Working.',
  queued: 'It has prompts waiting in its queue.',
  'provider-limited': 'A provider usage limit is holding it.',
  'awaiting-user': 'It is waiting for the person to answer it.',
  'waiting-for-yes': 'It is waiting for a yes to its own proposal.'
}

/** Which unverifiable case this is, so the report names what tidy cannot reach today. */
function unverifiableSkip(row: TidyRowInput, entry: SessionManageEntry): SessionTidyVerdict {
  const host = parseExecutionHostId(entry.hostId)
  const skip = (group: SessionTidyGroup, reason: string): SessionTidyVerdict => ({
    action: 'skip',
    reason,
    group
  })
  if (host?.kind === 'runtime') {
    return skip(
      'other-omniconsole',
      'It runs on another OmniConsole, so this computer cannot verify it; unverifiable is never read as done.'
    )
  }
  if (row.hostUnavailable) {
    return skip(
      'host-disconnected',
      'Its host is not connected, so it is unverifiable; that is never read as done.'
    )
  }
  return skip(
    'unverifiable',
    'Nothing on this computer proves its state (no readable terminal attached), so it is unverifiable; that is never read as done.'
  )
}

function finishedChainHold(chain: SessionChain): string | null {
  const set = chain.outcomeSet!
  if (chain.state === 'cancelled' || sessionCommitmentProof(chain)) {
    return null
  }
  if (set.attempts.some((attempt) => !['completed', 'superseded'].includes(attempt.state))) {
    return 'An attempt at its recorded outcomes failed or has not settled.'
  }
  if (sessionStillNeedsOwnerReview(chain)) {
    return 'Its delivered work still waits for the owner’s review.'
  }
  if (set.attention?.some((request) => request.state === 'open')) {
    return 'It has an open request for the person’s attention.'
  }
  if (set.heldContinuation) {
    return 'Its continuation is held.'
  }
  const seal = set.completion
  if (seal && (seal.planVersion ?? 1) !== (chain.planVersion ?? 1)) {
    return 'Its completion claim is for an older version of its plan.'
  }
  return 'Its recorded outcomes are not proven complete.'
}

/**
 * Why a recorded commitment keeps this conversation, or null when it has none open. The same
 * proof automatic archive requires (`sessionCommitmentProof`), over the chains this host holds.
 */
export function sessionTidyHoldReason(
  chains: readonly SessionChain[],
  row: Pick<TidyRowInput, 'rowKey' | 'paneKey' | 'worktreeId'>
): string | null {
  const own = chains.filter(
    (chain) =>
      chain.sourceRowKey === row.rowKey ||
      (row.paneKey !== null &&
        addressesConversation(chain, { paneKey: row.paneKey, worktreeId: row.worktreeId }))
  )
  if (own.some((chain) => chain.quarantine)) {
    return 'Its recorded outcome run is quarantined.'
  }
  const outcomeChains = own.filter((chain) => chain.outcomeSet)
  if (outcomeChains.some((chain) => !isFinishedOutcomeChain(chain))) {
    return 'Its recorded outcomes are not finished.'
  }
  const plain = own.filter((chain) => !chain.outcomeSet)
  if (plain.some(isLiveSessionChain)) {
    return 'Its session chain still has steps to run.'
  }
  if (plain.some((chain) => chain.state === 'failed')) {
    return 'Its session chain failed and has not been dismissed.'
  }
  // The pursuit it shows is its latest one; an older superseded run does not hold it.
  const latest = outcomeChains.reduce<SessionChain | null>(
    (best, chain) => (!best || chain.updatedAt > best.updatedAt ? chain : best),
    null
  )
  return latest ? finishedChainHold(latest) : null
}

/** Where one conversation lands in the plan. Skip wins over hold; `include` lifts only a hold. */
export function classifySessionTidy(
  row: TidyRowInput,
  entry: SessionManageEntry,
  hold: string | null,
  include: ReadonlySet<string>
): SessionTidyVerdict {
  const skip = (group: SessionTidyGroup, reason: string): SessionTidyVerdict => ({
    action: 'skip',
    reason,
    group
  })
  if (entry.archived) {
    return skip('already-archived', 'Already archived.')
  }
  if (!entry.paneKey || row.launchPending) {
    return skip('launch-pending', 'Its launch is still pending.')
  }
  if (row.hostUnavailable || entry.verdict === 'unverifiable') {
    return unverifiableSkip(row, entry)
  }
  const remote = remoteExecutionRefusal(entry, 'tidy')
  if (remote) {
    return skip('ssh-host', remote)
  }
  if (entry.state === 'unknown') {
    return skip('unknown-state', 'Its state is unknown; unknown means keep.')
  }
  if (entry.pinned) {
    return skip('pinned', 'Pinned.')
  }
  if (entry.saved) {
    return skip('saved', `Saved${entry.folder ? ` (${entry.folder})` : ''}.`)
  }
  const busy = BUSY_STATE_WORDS[entry.state]
  if (busy) {
    return skip('busy', busy)
  }
  if (hold) {
    return include.has(entry.paneKey)
      ? {
          action: 'archive',
          reason: `Held (${hold}) but the request names it.`,
          included: true
        }
      : { action: 'hold', reason: hold, group: 'held' }
  }
  if (entry.state === 'exited') {
    return { action: 'archive', reason: 'Exited.' }
  }
  if (entry.pendingSteps.length || entry.queueLength || entry.waitingOn) {
    return skip(
      'open-items',
      `Idle, but it has something open: ${entry.waitingOn ?? 'pending steps or queue'}`
    )
  }
  return {
    action: 'archive',
    reason: 'Idle with no pending steps, no queue and nothing waiting on the person.'
  }
}

export function toSessionTidyRow(
  entry: SessionManageEntry,
  verdict: SessionTidyVerdict,
  row?: Pick<TidyRowInput, 'workflow'>
): SessionTidyRow {
  // Why: apply re-checks and addresses a pane-less workflow anchor by its controller and run.
  const workflow = sessionWorkflowAnchorRef(row?.workflow)
  return {
    paneKey: entry.paneKey,
    tabId: entry.tabId,
    title: entry.title,
    folder: entry.folder,
    hostId: entry.hostId,
    state: entry.state,
    verdict: entry.verdict,
    action: verdict.action,
    reason: verdict.reason,
    ...(verdict.group ? { group: verdict.group } : {}),
    ...(verdict.included ? { included: true } : {}),
    ...(verdict.unverified ? { unverified: true } : {}),
    ...(workflow ? { workflow } : {})
  }
}

/** Where one conversation lands under the run's mode. */
export function classifySessionTidyFor(
  mode: SessionTidyMode,
  row: TidyRowInput,
  entry: SessionManageEntry,
  hold: string | null,
  include: ReadonlySet<string>
): SessionTidyVerdict {
  if (mode.delete && mode.selfPaneKey && entry.paneKey === mode.selfPaneKey) {
    return { action: 'skip', reason: 'This is the session running the cleanup.', group: 'busy' }
  }
  if (mode.delete && mode.selfTabId && entry.tabId === mode.selfTabId) {
    return {
      action: 'skip',
      reason:
        'It shares a tab with the session running the cleanup, and a delete closes the whole tab.',
      group: 'busy'
    }
  }
  // Why before every rule: no --include or --unverified lifts a wait on the person's answer.
  const waiting = mode.answerWait?.(row)
  if (waiting) {
    return { action: 'skip', reason: waiting, group: 'awaiting-answer' }
  }
  // Why before the pane rules: a workflow has no pane; its run decides (C6).
  const workflow = classifyWorkflowSessionTidy(row, entry, hold, include, {
    delete: mode.delete === true,
    unverified: mode.unverified === true,
    now: mode.now ?? Date.now()
  })
  if (workflow) {
    return workflow
  }
  return mode.delete
    ? classifySessionTidyDelete(row, entry, hold, include, {
        unverified: mode.unverified === true,
        now: mode.now ?? Date.now()
      })
    : classifySessionTidy(row, entry, hold, include)
}

export function planSessionTidy(
  observed: readonly { row: TidyRowInput; entry: SessionManageEntry }[],
  holdFor: (row: TidyRowInput) => string | null,
  include: ReadonlySet<string>,
  mode: SessionTidyMode = {}
): Omit<SessionTidyResult, 'dryRun' | 'actor'> {
  const rows = observed.map(({ row, entry }) =>
    toSessionTidyRow(entry, classifySessionTidyFor(mode, row, entry, holdFor(row), include), row)
  )
  const titleFlags = rows
    .filter((row) => isJunkSessionTitle(row.title))
    .map(({ paneKey, tabId, title }) => ({ paneKey, tabId, title }))
  const count = (action: SessionTidyAction): number =>
    rows.filter((row) => row.action === action).length
  return {
    rows,
    titleFlags,
    counts: {
      archive: count('archive'),
      hold: count('hold'),
      skip: count('skip'),
      junkTitles: titleFlags.length,
      ...(mode.delete ? { delete: count('delete') } : {})
    },
    ...(mode.delete ? { mode: 'delete' as const } : {})
  }
}

export { applySessionTidy, type SessionTidyApplyDeps } from './session-manage-tidy-apply'
