import type { FollowUpReaskPlan } from './session-follow-up-reask-plan'
import { normalizeSessionFollowUpRecipients } from './session-follow-up-recipients'
import { readPlanVersion } from './session-chain-record-fields'
import { BOARD_TASK_ID_PATTERN } from './board-task-id'
import type { ExactHandoffFile, HandoffSend } from './console-handoff-contract'
import {
  sessionFollowUpTranscriptSource,
  type SessionFollowUpTranscriptSource
} from './session-follow-up-transcript'
import { communicationType, type CommunicationType } from './communication-type'
import { normalizeHandoffArtifactReview } from './handoff-artifact-review'
import {
  normalizeFollowUpAgents,
  type SessionFollowUpAgentRecipient
} from './session-follow-up-agent'
import {
  finite,
  matching,
  normalizeCapture,
  normalizeDeliverables,
  normalizeException,
  oneOf,
  record,
  text,
  type SessionFollowUpDeliverables,
  type SessionFollowUpException,
  type SessionFollowUpFilePin,
  type SessionFollowUpRequestText
} from './session-follow-up-rule-fields'

/**
 * A saved "when this session finishes, send its final files to …" rule. It is the
 * handoff step of a session chain: the chain waits on the session, and this records
 * what the later handoff sends, to whom, and every effect it already had, so a
 * restart or a duplicate completion replays the same request instead of a second one.
 */
/** What the person is asked for; absent means "the work says it": the hub keeps the thread's action NULL. */
export {
  SESSION_FOLLOW_UP_EXCEPTION_CODES,
  SESSION_FOLLOW_UP_MAX_FILE_BYTES,
  SESSION_FOLLOW_UP_MAX_FILES,
  SESSION_FOLLOW_UP_MAX_MANIFESTS,
  SESSION_FOLLOW_UP_MAX_NAME_CHARS,
  SESSION_FOLLOW_UP_SUMMARY_MAX_CHARS
} from './session-follow-up-rule-fields'
export type {
  SessionFollowUpDeliverables,
  SessionFollowUpException,
  SessionFollowUpExceptionCode,
  SessionFollowUpFilePin,
  SessionFollowUpRequestText
} from './session-follow-up-rule-fields'

export type SessionFollowUpAction = NonNullable<HandoffSend['action']>

export const SESSION_FOLLOW_UP_ACTIONS = [
  'review',
  'approve',
  'decide',
  'edit',
  'fyi'
] as const satisfies readonly SessionFollowUpAction[]

export const SESSION_FOLLOW_UP_MAX_RECIPIENTS = 20
export const SESSION_FOLLOW_UP_MAX_TITLE_CHARS = 500
export const SESSION_FOLLOW_UP_MAX_NOTE_CHARS = 8192

export type SessionFollowUpDelivery = 'pending' | 'sending' | 'sent' | 'failed'
export type SessionFollowUpDisposition = 'feedback' | 'ownership-transfer'

export type SessionFollowUpRecipient = {
  employeeId: string
  name: string
  /** The hub idempotency key for this person's request, minted when the rule is saved. */
  operationId: string
  /** `sending` is persisted before the request leaves; a restart replays it with the same key. */
  delivery: SessionFollowUpDelivery
  /** Absent on the opening request; subsequent review rounds are positive integers. */
  round?: number
  /** Frozen request bases and names, scoped to operationId for restart replay. */
  reaskPlan?: FollowUpReaskPlan
  threadId?: string
  error?: string
  at?: number
  /** The delivery receipt also acknowledged the requested ownership transfer. */
  ownershipTransferredAt?: number
}

export type SessionFollowUpRule = {
  reask?: true
  destinationDirectory?: string
  /** Increments on every edit; a run only acts for the revision it started with. */
  revision: number
  /** The card the request lands on; null when the handoff stands on its own (no card). */
  taskId: string | null
  taskTitle: string
  sessionLabel: string
  recipients: SessionFollowUpRecipient[]
  agentRecipients?: SessionFollowUpAgentRecipient[]
  sourceConversationId?: string
  action?: SessionFollowUpAction
  communicationType?: CommunicationType
  /** Missing on legacy rules: review meant feedback; every other action ended ownership. */
  disposition?: SessionFollowUpDisposition
  deliverables: SessionFollowUpDeliverables
  includeWorkingTree?: boolean
  includeSummary: boolean
  transcriptSource?: SessionFollowUpTranscriptSource
  note: string
  /** `note` is what the sender typed, even when it reads like the plan's title; absent = may be the default. */
  noteAuthored?: true
  dueAt?: string
  savedAt: number
  /** Deliverables still missing at the last stop; delivery waits for the next one. */
  waitingForFiles?: string[]
  /** Named files were all present at a stop; the run is not finished until confirmed or a clean exit. */
  readyAt?: number
  /** The person confirmed the run is finished; delivery goes ahead at its stop. */
  confirmedAt?: number
  /** Set once the final bytes were captured; from here on only delivery remains. */
  capturedAt?: number
  files?: SessionFollowUpFilePin[]
  summaryMarkdown?: string
  transcriptFile?: ExactHandoffFile
  /** What the person reads first: a title and a description written from the conversation itself. */
  request?: SessionFollowUpRequestText
  /** The generated summary among `files`, by name. */
  summaryFile?: string
  /**
   * An omnios page the people are asked to decide on (`handoff-artifact-review.ts`): each request
   * reads "Review: <title>", links the page, and makes its person a named reviewer before it leaves.
   */
  artifactReview?: { slug: string; title: string; url?: string }
  exception?: SessionFollowUpException
}

export type SessionChainHandoffStep = {
  kind: 'handoff'
  id: string
  outcomeId?: string
  /** Same meaning as on an agent step: members of a fan-out act after the same source. */
  group?: string
  planVersion?: number
  supersededBy?: number
  status: 'queued' | 'delivered' | 'skipped'
  handoff: SessionFollowUpRule
}

export function normalizeSessionFollowUpRule(value: unknown): SessionFollowUpRule | null {
  const raw = record(value)
  // Why: an explicit null is a card-less request; a missing or malformed id is still not a rule.
  const taskId = raw?.taskId === null ? null : matching(raw?.taskId, BOARD_TASK_ID_PATTERN)
  const taskTitle = text(raw?.taskTitle, SESSION_FOLLOW_UP_MAX_TITLE_CHARS)
  const action = oneOf(raw?.action, SESSION_FOLLOW_UP_ACTIONS)
  const disposition = oneOf(raw?.disposition, ['feedback', 'ownership-transfer'] as const)
  const deliverables = normalizeDeliverables(raw?.deliverables)
  const note = text(raw?.note, SESSION_FOLLOW_UP_MAX_NOTE_CHARS)
  if (!raw || taskId === undefined || !taskTitle || !deliverables || !note) {
    return null
  }
  const recipients = normalizeSessionFollowUpRecipients(raw.recipients)
  const agentRecipients = normalizeFollowUpAgents(raw.agentRecipients)
  const sourceConversationId = matching(raw.sourceConversationId, /^[A-Za-z0-9:._-]{1,128}$/)
  if (
    !agentRecipients ||
    (raw.sourceConversationId !== undefined && !sourceConversationId) ||
    (agentRecipients.length && !sourceConversationId)
  ) {
    return null
  }
  const includeSummary = raw.includeSummary === true
  const transcript =
    raw.transcriptSource === undefined
      ? undefined
      : sessionFollowUpTranscriptSource.safeParse(raw.transcriptSource)
  if (transcript && !transcript.success) {
    return null
  }
  if (
    recipients.length + agentRecipients.length === 0 ||
    recipients.length + agentRecipients.length > SESSION_FOLLOW_UP_MAX_RECIPIENTS
  ) {
    return null
  }
  if (
    raw.communicationType !== undefined &&
    !communicationType.safeParse(raw.communicationType).success
  ) {
    return null
  }
  const dueAt =
    typeof raw.dueAt === 'string' && !Number.isNaN(Date.parse(raw.dueAt)) ? raw.dueAt : undefined
  const revision = finite(raw.revision)
  const waiting = Array.isArray(raw.waitingForFiles)
    ? raw.waitingForFiles
        .filter((name): name is string => typeof name === 'string' && !!name.trim())
        .slice(0, 64)
    : []
  const exception = normalizeException(raw.exception)
  const readyAt = finite(raw.readyAt)
  const confirmedAt = finite(raw.confirmedAt)
  const artifactReview = normalizeHandoffArtifactReview(raw.artifactReview)
  return {
    revision: revision !== undefined && Number.isInteger(revision) && revision > 0 ? revision : 1,
    taskId,
    taskTitle,
    sessionLabel: text(raw.sessionLabel, SESSION_FOLLOW_UP_MAX_TITLE_CHARS) ?? taskTitle,
    recipients,
    ...(raw.reask === true ? { reask: true } : {}),
    ...(agentRecipients.length ? { agentRecipients } : {}),
    ...(sourceConversationId ? { sourceConversationId } : {}),
    ...(action ? { action } : {}),
    ...(raw.communicationType
      ? { communicationType: communicationType.parse(raw.communicationType) }
      : {}),
    ...(disposition ? { disposition } : {}),
    deliverables,
    ...(text(raw.destinationDirectory, 4096)
      ? { destinationDirectory: text(raw.destinationDirectory, 4096) }
      : {}),
    includeSummary,
    ...(raw.includeWorkingTree === true ? { includeWorkingTree: true } : {}),
    ...(transcript?.success ? { transcriptSource: transcript.data } : {}),
    note,
    ...(raw.noteAuthored === true ? { noteAuthored: true } : {}),
    ...(dueAt ? { dueAt } : {}),
    savedAt: finite(raw.savedAt) ?? 0,
    ...(waiting.length > 0 ? { waitingForFiles: waiting } : {}),
    ...(readyAt !== undefined ? { readyAt } : {}),
    ...(confirmedAt !== undefined ? { confirmedAt } : {}),
    ...normalizeCapture(raw),
    ...(artifactReview ? { artifactReview } : {}),
    ...(exception ? { exception } : {})
  }
}

export function sessionFollowUpDisposition(
  rule: Pick<SessionFollowUpRule, 'action' | 'disposition'>
): SessionFollowUpDisposition {
  return rule.disposition ?? (rule.action === 'review' ? 'feedback' : 'ownership-transfer')
}

export function isSessionFollowUpDelivered(rule: SessionFollowUpRule): boolean {
  return (
    rule.recipients.every((recipient) => recipient.delivery === 'sent') &&
    (rule.agentRecipients ?? []).every((recipient) => recipient.delivery === 'sent')
  )
}

/**
 * Named files carry no declaration from the run, and an idle prompt only ends a turn,
 * so they need a clean exit or the person's confirmation. A manifest is the run's own.
 */
export function sessionFollowUpNeedsConfirmedFinish(
  rule: Pick<SessionFollowUpRule, 'deliverables' | 'transcriptSource'>
): boolean {
  // An idle prompt ends a turn, not the session. History and message-only handoffs
  // need the same completion evidence as named files; a manifest declares its own finish.
  return !!rule.transcriptSource || rule.deliverables.kind === 'files'
}

/** A capture that changed or could not be re-read before any request left can start over. */
export function canRecaptureSessionFollowUp(rule: SessionFollowUpRule): boolean {
  const code = rule.exception?.code
  return (
    rule.capturedAt !== undefined &&
    (code === 'files-changed' || code === 'unreadable') &&
    rule.recipients.every(
      (recipient) => recipient.delivery === 'pending' || recipient.delivery === 'failed'
    ) &&
    (rule.agentRecipients ?? []).every(
      (recipient) => recipient.delivery === 'pending' || recipient.delivery === 'failed'
    )
  )
}

/** True once capture began; from here the rule can be retried or cancelled, never edited. */
export function hasSessionFollowUpStartedDelivery(rule: SessionFollowUpRule): boolean {
  return (
    rule.capturedAt !== undefined ||
    rule.recipients.some((recipient) => recipient.delivery !== 'pending') ||
    (rule.agentRecipients ?? []).some((recipient) => recipient.delivery !== 'pending')
  )
}

export function normalizeSessionChainHandoffStep(
  raw: Record<string, unknown>
): SessionChainHandoffStep | null {
  const id = text(raw.id, 200)
  const handoff = normalizeSessionFollowUpRule(raw.handoff)
  if (!id || !handoff) {
    return null
  }
  const delivered = raw.status === 'delivered' && isSessionFollowUpDelivered(handoff)
  const group = text(raw.group, 200)
  const outcomeId = text(raw.outcomeId, 128)
  return {
    kind: 'handoff',
    id,
    ...(outcomeId ? { outcomeId } : {}),
    ...(group ? { group } : {}),
    ...(readPlanVersion(raw.planVersion) ? { planVersion: readPlanVersion(raw.planVersion) } : {}),
    ...(readPlanVersion(raw.supersededBy)
      ? { supersededBy: readPlanVersion(raw.supersededBy) }
      : {}),
    status: raw.status === 'skipped' ? 'skipped' : delivered ? 'delivered' : 'queued',
    handoff
  }
}
