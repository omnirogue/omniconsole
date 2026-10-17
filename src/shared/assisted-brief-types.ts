import type { TuiAgent } from './tui-agent'

/**
 * "Help me shape this": a short brief drafted from a rough request before any work starts.
 * The person's words stay verbatim beside the brief, and every brief line records who wrote it.
 */
export const BRIEF_LIST_SECTIONS = [
  'scope',
  'constraints',
  'assumptions',
  'deliverables',
  'successChecks'
] as const
export type BriefListSection = (typeof BRIEF_LIST_SECTIONS)[number]

/** request / answer / person lines are the person's requirements; the rest are AI proposals. */
export type BriefItemOrigin =
  | 'request'
  | 'answer'
  | 'person'
  | 'ai-assumption'
  | 'ai-suggestion'
  | 'challenge'

export type BriefItem = { id: string; text: string; origin: BriefItemOrigin }

export type BriefAttachmentRef = { name: string; path: string }

export type BriefOriginalRequest = { text: string; attachments: BriefAttachmentRef[] }

export type BriefQuestion = {
  id: string
  prompt: string
  /** Empty when the question needs a typed answer. */
  choices: string[]
  /** Where the answer lands; an answer is the person's requirement. */
  section: BriefListSection
}

export type BriefContent = {
  outcome: BriefItem
  sections: Record<BriefListSection, BriefItem[]>
  /** Open questions, asked together. Answering one removes it and records the answer. */
  questions: BriefQuestion[]
}

/** The one-shot model that drafted or reviewed a brief; never a team. */
export type BriefActor = {
  agent: TuiAgent
  model?: string
  effort?: string
  /** `managed:<id>` / `profile:<id>` choice id, never a credential. */
  accountChoiceId?: string
  label: string
}

export type BriefRevisionCause =
  | 'drafted'
  | 'edited'
  | 'added'
  | 'answered'
  | 'removed'
  | 'challenge-applied'
  | 'workspace-changed'

export type BriefRevision = {
  number: number
  cause: BriefRevisionCause
  createdAt: number
  content: BriefContent
  /** Hash over the canonical brief, the original request and the workspace key. */
  contentHash: string
}

export type BriefApproval = {
  revision: number
  contentHash: string
  workspaceKey: string
  approvedAt: number
}

export type BriefStartStatus = 'starting' | 'started' | 'not-started' | 'unconfirmed'
export type BriefStartFailure = 'blocked' | 'repeat' | 'launch-failed' | 'released'

export type BriefStartRecord = {
  /** Stable per approved revision, so retries and restarts name the same start. */
  operationId: string
  /** Tab id the launch asks for; a restart looks for this tab instead of launching again. */
  tabId: string
  launchedTabId: string | null
  revision: number
  contentHash: string
  workspaceKey: string
  favoriteId: string
  status: BriefStartStatus
  /** False when the client cannot find the launched session later (paired-host tabs). */
  verifiable: boolean
  requestedAt: number
  settledAt?: number
  failure?: BriefStartFailure
}

export type BriefChallengeKind =
  | 'missed-requirement'
  | 'unsupported-assumption'
  | 'unnecessary-work'
  | 'regression-risk'

export type BriefChallengeChange =
  | { action: 'add'; section: BriefListSection; text: string }
  | { action: 'remove'; targetItemId: string }
  | { action: 'none' }

export type BriefChallengeFinding = {
  id: string
  kind: BriefChallengeKind
  note: string
  change: BriefChallengeChange
  decision: 'pending' | 'accepted' | 'rejected'
}

export type BriefChallenge = {
  /** The revision the reviewer read. */
  revision: number
  reviewer: BriefActor
  findings: BriefChallengeFinding[]
  status: 'open' | 'applied'
}

export type AssistedBriefRecord = {
  version: 1
  briefId: string
  workspaceKey: string
  original: BriefOriginalRequest
  /** Copied verbatim from the request, never from AI output. */
  namedModels: string[]
  drafter: BriefActor
  /** Oldest first; the last entry is the current revision. */
  revisions: BriefRevision[]
  approval: BriefApproval | null
  starts: BriefStartRecord[]
  challenge: BriefChallenge | null
  /** The independent review is bounded to one review-and-revision cycle per brief. */
  challengeCycles: number
  updatedAt: number
}

export const ASSISTED_BRIEF_LIMITS = {
  requestChars: 8_000,
  itemChars: 600,
  /** Stored bound; a fresh draft keeps far fewer lines per section. */
  itemsPerSection: 16,
  draftItemsPerSection: 6,
  questions: 3,
  choicesPerQuestion: 4,
  attachments: 10,
  revisionsKept: 20,
  startsKept: 10,
  findings: 6,
  namedModels: 12,
  challengeCycles: 1
} as const

/** Injected so the pure transitions stay deterministic in tests. */
export type BriefClock = { now: number; newId: () => string }
