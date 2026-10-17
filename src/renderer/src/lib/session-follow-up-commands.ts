import { translate } from '@/i18n/i18n'
import { removeSessionChainOnHost } from '@/lib/session-chain-client'
import {
  deleteSessionChainEntry,
  getSessionChainEntry,
  getSessionFollowUpChains,
  persistSessionChainOrThrow,
  publishSessionChains,
  setSessionChainEntry,
  updateSessionChain
} from '@/lib/session-chain-registry'
import { runSessionChainNow, stopSessionChainRun } from '@/lib/session-chain-runner'
import { LOCAL_CHAIN_TARGET, randomChainId } from '@/lib/session-chain-support'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { useAppStore } from '@/store'
import { parseExecutionHostId } from '../../../shared/execution-host'
import {
  isLiveSessionChain,
  sessionFollowUpStep,
  type SessionChain,
  type SessionChainHandoffStep
} from '../../../shared/session-chain-types'
import {
  canRecaptureSessionFollowUp,
  hasSessionFollowUpStartedDelivery,
  SESSION_FOLLOW_UP_MAX_NAME_CHARS,
  SESSION_FOLLOW_UP_MAX_NOTE_CHARS,
  SESSION_FOLLOW_UP_MAX_RECIPIENTS,
  SESSION_FOLLOW_UP_MAX_TITLE_CHARS,
  type SessionFollowUpAction,
  type SessionFollowUpDeliverables,
  type SessionFollowUpRecipient,
  type SessionFollowUpRule
} from '../../../shared/session-follow-up-rule'

/**
 * Save, edit, confirm, cancel and retry a follow-up on a session. Both entry points
 * (the sentence box and the Next step controls) end in `saveSessionFollowUp`, so they
 * persist the same rule; the chain runner does the waiting and the delivery.
 */
export type SessionFollowUpDraft = {
  /** Null when card-less handoffs are on and the session has no card. */
  taskId: string | null
  taskTitle: string
  recipients: readonly { employeeId: string; name: string }[]
  action?: SessionFollowUpAction
  deliverables: SessionFollowUpDeliverables
  includeSummary: boolean
  note: string
  dueAt?: string
}

export type SessionFollowUpSource = Pick<
  SidebarSession,
  'rowKey' | 'worktreeId' | 'hostId' | 'paneKey' | 'label'
>

function newOperationId(): string {
  return `fu_${crypto.randomUUID().replace(/-/g, '')}`
}

function clamp(value: string, max: number): string {
  return value.trim().slice(0, max).trim()
}

function followUpRank(chain: SessionChain): number {
  return isLiveSessionChain(chain) ? 0 : chain.state === 'failed' ? 1 : 2
}

/** The follow-up saved on a session: live first, then an exception, then the latest record. */
export function pickSessionFollowUp(
  chains: readonly SessionChain[],
  worktreeId: string,
  paneKey: string | null
): SessionChain | null {
  if (!paneKey) {
    return null
  }
  const matches = chains.filter(
    (chain) => chain.worktreeId === worktreeId && chain.sourcePaneKey === paneKey
  )
  return (
    [...matches].sort(
      (left, right) => followUpRank(left) - followUpRank(right) || right.updatedAt - left.updatedAt
    )[0] ?? null
  )
}

/** Why this session cannot take a follow-up, or null when it can. */
export function sessionFollowUpRefusal(source: SessionFollowUpSource): string | null {
  if (!source.paneKey) {
    return translate(
      'sessionFollowUp.noPane',
      'This session has no terminal pane to wait on. Open it in its workspace first.'
    )
  }
  if (parseExecutionHostId(source.hostId)?.kind === 'runtime') {
    return translate(
      'sessionFollowUp.pairedHost',
      'Files on a paired host cannot be captured from this computer yet, so a follow-up cannot be saved for this session.'
    )
  }
  if (!useAppStore.getState().getKnownWorktreeById(source.worktreeId)?.path) {
    return translate(
      'sessionFollowUp.workspaceMissing',
      'The source workspace is no longer available.'
    )
  }
  return null
}

// Why: limits are applied here, so persisting is never the first place one is hit.
function buildRule(
  draft: SessionFollowUpDraft,
  sessionLabel: string,
  revision: number
): SessionFollowUpRule {
  const label = clamp(sessionLabel, SESSION_FOLLOW_UP_MAX_TITLE_CHARS)
  const note =
    clamp(draft.note, SESSION_FOLLOW_UP_MAX_NOTE_CHARS) ||
    translate(
      'sessionFollowUp.defaultNote',
      'Final deliverables from {{session}}, sent when the session finished.',
      { session: label }
    )
  return {
    revision,
    taskId: draft.taskId,
    taskTitle: clamp(draft.taskTitle, SESSION_FOLLOW_UP_MAX_TITLE_CHARS) || draft.taskId || label,
    sessionLabel: label,
    recipients: draft.recipients.map((recipient) => ({
      employeeId: recipient.employeeId,
      name: clamp(recipient.name, SESSION_FOLLOW_UP_MAX_NAME_CHARS) || recipient.employeeId,
      operationId: newOperationId(),
      delivery: 'pending'
    })),
    ...(draft.action ? { action: draft.action } : {}),
    deliverables: draft.deliverables,
    includeSummary: draft.includeSummary,
    note: clamp(note, SESSION_FOLLOW_UP_MAX_NOTE_CHARS),
    ...(draft.dueAt ? { dueAt: draft.dueAt } : {}),
    savedAt: Date.now()
  }
}

function withStep(
  chain: SessionChain,
  step: SessionChainHandoffStep,
  patch: Partial<Pick<SessionChain, 'state' | 'error'>> = {}
): SessionChain {
  return {
    ...chain,
    ...patch,
    steps: chain.steps.map((candidate) => (candidate.id === step.id ? step : candidate)),
    updatedAt: Date.now()
  }
}

/**
 * Put a follow-up's new record in place and run it. The registry changes before the
 * write, so a superseded run can no longer match what it holds; a failed write
 * restores the previous record (and its run) instead of leaving the two apart.
 */
async function replaceSessionFollowUp(
  previous: SessionChain | null,
  next: SessionChain
): Promise<void> {
  if (previous) {
    stopSessionChainRun(previous.id)
  }
  setSessionChainEntry(next)
  publishSessionChains()
  // Cancellation, dismissal or another edit replaces this object while persistence
  // is pending. Only the operation that still owns the registry entry may restore/run it.
  const isCurrent = (): boolean => getSessionChainEntry(next.id)?.chain === next
  try {
    await persistSessionChainOrThrow(next)
  } catch (error) {
    if (isCurrent()) {
      if (previous) {
        setSessionChainEntry(previous)
        if (isLiveSessionChain(previous)) {
          runSessionChainNow(previous.id)
        }
      } else {
        deleteSessionChainEntry(next.id)
      }
      publishSessionChains()
    }
    throw error
  }
  if (isCurrent()) {
    runSessionChainNow(next.id)
  }
}

/** Save a new rule, or a new revision of the one not yet delivering; the run starts at once. */
export async function saveSessionFollowUp(
  source: SessionFollowUpSource,
  draft: SessionFollowUpDraft
): Promise<SessionChain> {
  const refusal = sessionFollowUpRefusal(source)
  const workspacePath = useAppStore.getState().getKnownWorktreeById(source.worktreeId)?.path
  if (refusal || !workspacePath || !source.paneKey) {
    throw new Error(refusal ?? '')
  }
  if (draft.recipients.length === 0) {
    throw new Error(translate('sessionFollowUp.needPeople', 'Choose at least one person.'))
  }
  if (draft.recipients.length > SESSION_FOLLOW_UP_MAX_RECIPIENTS) {
    throw new Error(
      translate('sessionFollowUp.tooManyPeople', 'One next step goes to at most 20 people.')
    )
  }
  const existing = pickSessionFollowUp(
    getSessionFollowUpChains(),
    source.worktreeId,
    source.paneKey
  )
  const editable =
    existing && (isLiveSessionChain(existing) || existing.state === 'failed') ? existing : null
  const previous = editable ? sessionFollowUpStep(editable) : null
  if (previous && hasSessionFollowUpStartedDelivery(previous.handoff)) {
    throw new Error(
      translate(
        'sessionFollowUp.editClosed',
        'Delivery already started. Retry or cancel it instead of editing.'
      )
    )
  }
  const now = Date.now()
  // Why: a fresh step id means a run still holding the old revision can no longer write to it.
  const step: SessionChainHandoffStep = {
    kind: 'handoff',
    id: `step_1_${randomChainId('s').slice(2)}`,
    status: 'queued',
    handoff: buildRule(draft, source.label, (previous?.handoff.revision ?? 0) + 1)
  }
  const chain: SessionChain = editable
    ? { ...editable, steps: [step], currentIndex: 0, state: 'waiting', error: null, updatedAt: now }
    : {
        id: randomChainId('chn'),
        workspacePath,
        worktreeId: source.worktreeId,
        hostId: source.hostId,
        sourcePaneKey: source.paneKey,
        sourceRowKey: source.rowKey,
        // Why: the saved instruction authorises the later handoff; no second approval at completion.
        auto: true,
        steps: [step],
        currentIndex: 0,
        state: 'waiting',
        createdAt: now,
        updatedAt: now
      }
  // Why: persisted before the run starts, so the rule survives a restart from its first moment.
  await replaceSessionFollowUp(editable, chain)
  return chain
}

/** The person confirms the run is finished: the files present at its stop go out now. */
export async function confirmSessionFollowUpFinished(chainId: string): Promise<void> {
  const chain = getSessionChainEntry(chainId)?.chain
  const step = chain ? sessionFollowUpStep(chain) : null
  if (!chain || !step || !isLiveSessionChain(chain)) {
    return
  }
  if (step.handoff.readyAt === undefined) {
    throw new Error(
      translate(
        'sessionFollowUp.notReady',
        'The session is working again, so this waits for its next stop.'
      )
    )
  }
  const handoff = { ...step.handoff, confirmedAt: Date.now() }
  await replaceSessionFollowUp(chain, withStep(chain, { ...step, handoff }, { state: 'waiting' }))
}

/** Stop the rule before its next effect; a request already in flight is still recorded. */
export async function cancelSessionFollowUp(chainId: string): Promise<void> {
  stopSessionChainRun(chainId)
  const cancelled = updateSessionChain(chainId, { state: 'cancelled', error: null })
  if (cancelled) {
    await persistSessionChainOrThrow(cancelled)
  }
}

/**
 * Run again: sent people stay sent, unconfirmed ones replay their key, refused ones
 * get a new one. A capture that changed before anything left is taken again.
 */
export async function retrySessionFollowUp(chainId: string): Promise<void> {
  const chain = getSessionChainEntry(chainId)?.chain
  const step = chain ? sessionFollowUpStep(chain) : null
  if (!chain || !step) {
    return
  }
  const recapture = canRecaptureSessionFollowUp(step.handoff)
  const { exception: _cleared, readyAt: _ready, ...kept } = step.handoff
  const { capturedAt: _captured, files: _files, summaryMarkdown: _summary, ...uncaptured } = kept
  const rule: SessionFollowUpRule = recapture ? uncaptured : kept
  // Why: a refused request was never admitted, so a fresh key cannot duplicate it.
  const recipients = rule.recipients.map((recipient): SessionFollowUpRecipient =>
    recipient.delivery === 'failed'
      ? {
          employeeId: recipient.employeeId,
          name: recipient.name,
          operationId: newOperationId(),
          delivery: 'pending'
        }
      : recipient
  )
  const next = withStep(
    chain,
    { ...step, handoff: { ...rule, recipients } },
    { state: 'waiting', error: null }
  )
  await replaceSessionFollowUp(chain, next)
}

/** Forget a finished or cancelled record; the delivered threads stay on the task. */
export async function dismissSessionFollowUp(chainId: string): Promise<void> {
  stopSessionChainRun(chainId)
  deleteSessionChainEntry(chainId)
  publishSessionChains()
  await removeSessionChainOnHost(LOCAL_CHAIN_TARGET, chainId)
}
