import type { CommunicationType } from './communication-type'
import type { SessionFollowUpTranscriptSource } from './session-follow-up-transcript'
import type { ChatRecipient } from './chat-delivery'
import type { ExecutionHostId } from './execution-host'
import {
  SESSION_ACTION_PRESET_INSTRUCTIONS,
  type SessionActionPresetId
} from './session-action-presets'
import type { SessionFollowUpAction, SessionFollowUpDeliverables } from './session-follow-up-rule'
import type { TuiAgent } from './tui-agent'

/**
 * the recipient choice as one draft for agents and people alike. One recipient is a
 * handoff, several are a fan-out, and what happens when the agents finish is asked
 * only then. The draft compiles into ordinary session-chain steps; nothing here is a
 * new runtime concept.
 */
export const NEXT_STEP_MAX_ROUNDS = 8
/** Canonical review loops allow one producer and up to five reviewers, over five rounds. */
export const NEXT_STEP_MAX_REVIEW_ROUNDS = 5
export const NEXT_STEP_MAX_REVIEWERS = 5
export const NEXT_STEP_MAX_SEQUENTIAL_HANDOFFS = 6
/** Actions that make sense repeated on their own previous result. */
export const NEXT_STEP_ROUND_PRESETS: readonly SessionActionPresetId[] = [
  'improve',
  'review',
  'verify'
]

export type NextStepActor = {
  agent: TuiAgent
  model?: string
  /** Ordered OpenRouter API IDs; the selected model is first. Omitted means fixed-only. */
  openrouterCandidates?: string[]
  effort?: string
  accountChoiceId?: string | null
}

export type NextStepAgentRecipient = NextStepActor & {
  kind: 'agent'
  /** Client-side identity of this recipient inside the draft. */
  key: string
  presetId: SessionActionPresetId | null
  /** The objective line the preset frames; pre-filled from the action, edited freely. */
  instructions: string
  rounds: number
}

export type NextStepPersonRecipient = { kind: 'person'; key: string; id: string; name: string }

export type NextStepRecipient = NextStepAgentRecipient | NextStepPersonRecipient

/**
 * One follow-on step after the recipients (and after the previous follow-on): an agent
 * doing an action on the result, or a person receiving it. Only meaningful with at
 * least one agent among the recipients; each step feeds the next.
 */
export type NextStepAfterStep = { level?: number } & (
  | {
      kind: 'agent'
      key: string
      actor: NextStepActor
      presetId: SessionActionPresetId
      instructions: string
      rounds: number
    }
  /** `action: 'review'` is the ask coming back to me, not a handoff of ownership. */
  | { kind: 'person'; key: string; id: string; name: string; action?: SessionFollowUpAction }
)

export type NextStepHandoffOptions = {
  sourceConversationId?: string
  communicationType?: CommunicationType
  destinationDirectory?: string
  task: { id: string; title: string } | null
  /** How the current work travels to people; null means "the final summary of this session". */
  deliverables: SessionFollowUpDeliverables | null
  includeSummary: boolean
  /** The owner ticked "include the session transcript". Off unless chosen: the
   *  transcript can carry anything the session read or ran, so it is never a
   *  default. The redacted file is built and pinned at dispatch. */
  includeTranscript?: boolean
  transcriptSource?: SessionFollowUpTranscriptSource
  dueAt?: string
  action?: SessionFollowUpAction
  /** An omnios page the people are asked to decide on; see `handoff-artifact-review.ts`. */
  artifactReview?: { slug: string; title: string; url?: string }
}

/** A verifiable finish for one independently tracked obligation. */
export type NextStepOutcomeFinish =
  | { kind: 'complete' }
  | { kind: 'my-review' }
  | {
      kind: 'person'
      personId: string
      personName: string
      /**
       * Every person this outcome goes to, the primary one first (`personId`). Absent, or a
       * single entry naming `personId`, is the one-person case and compiles byte-identically
       * to what it always did. Several people are a REVIEW by all of them: each one gets its
       * own request and its own condition, so the chain continues only when every one of them
       * has replied. A handoff moves ownership and stays one person.
       */
      people?: { id: string; name: string }[]
      /** An existing employee agent session; selecting it never starts a replacement agent. */
      agentRecipient?: Extract<ChatRecipient, { kind: 'agent' }>
      /** Ownership is terminal; feedback returns to the directing user. */
      disposition: 'ownership' | 'feedback'
      action: SessionFollowUpAction
    }
  | {
      kind: 'github'
      action: 'create-pr' | 'merge' | 'merge-and-deploy'
      repository?: string
      targetBranch?: string
      deploymentTarget?: string
    }

/**
 * How the run policy reads an outcome that has not finished, carried so a draft shown without its
 * chain still says it. `failed` and `recovering` are never "needs you".
 */
type NextStepUnfinishedStatus = 'waiting' | 'needs-you' | 'failed' | 'recovering'
export type NextStepOutcomeStatus = 'pending' | NextStepUnfinishedStatus | 'complete'

export type NextStepOutcomeStep =
  | {
      id: string
      kind: 'review'
      reviewers: NextStepActor[]
      maxRounds: number
      /** The original producer repairs blocking findings between review rounds. */
      repairWithSource?: boolean
      instructions: string
      adversarial: boolean
    }
  | {
      id: string
      kind: 'handoff'
      actor: NextStepActor | null
      presetId: SessionActionPresetId
      instructions: string
      /** Consecutive agent steps sharing a key are independent surfaces that launch together. */
      parallelGroup?: string
      /** Runs only for blocking findings between rounds of the immediately preceding review. */
      reviewRepair?: boolean
    }

/**
 * Renderer draft plus optional persisted facts. `evidence` and `needsYouReason` come from the
 * outcome runtime; they are never set by Save in the renderer.
 */
export type NextStepOutcomeDraft = {
  id: string
  revision?: number
  finish: NextStepOutcomeFinish | null
  instructions: string
  steps: NextStepOutcomeStep[]
  status?: NextStepOutcomeStatus
  evidence?: readonly string[]
  needsYouReason?: string
}

export type NextStepDraft = {
  end: 'me' | 'done'
  placement: ExecutionHostId | null
  /**
   * The workspace the person was shown for `placement` before Send. Resolved once by the panel;
   * the send refuses rather than running somewhere else if it no longer resolves the same way.
   */
  destinationWorktreeId?: string
  mode?: 'handoff' | 'review'
  recipients: NextStepRecipient[]
  note: string
  /** The person typed `note` on a Person block; it is never the plan's default title. */
  noteAuthored?: true
  after: NextStepAfterStep[]
  handoff: NextStepHandoffOptions
  /** Omitted records are legacy single-outcome chains until their owner migrates them. */
  outcomes?: NextStepOutcomeDraft[]
  /** Explicit scope changes for committed outcomes; sent with the atomic revision. */
  outcomeRemovals?: { outcomeId: string; reason: string }[]
}

export type NextStepProblem =
  | { kind: 'too-many-levels' }
  | { kind: 'invalid-level' }
  | { kind: 'handoff-needs-one-recipient' }
  | { kind: 'no-recipients' }
  | { kind: 'agent-needs-action'; key: string }
  | { kind: 'no-task' }
  | { kind: 'no-person' }
  | { kind: 'too-many-people' }
  | { kind: 'too-many-agents' }
  | { kind: 'invalid-review-repair'; key: string }

/** One source of truth with the composer's presets; every preset has a non-empty default. */
export const DEFAULT_NEXT_STEP_INSTRUCTIONS: Record<SessionActionPresetId, string> =
  SESSION_ACTION_PRESET_INSTRUCTIONS

export function defaultNextStepInstructions(presetId: SessionActionPresetId): string {
  return DEFAULT_NEXT_STEP_INSTRUCTIONS[presetId]
}

export function emptyNextStepDraft(): NextStepDraft {
  return {
    end: 'me',
    placement: null,
    recipients: [],
    note: '',
    after: [],
    handoff: { task: null, deliverables: null, includeSummary: true },
    outcomes: [emptyNextStepOutcomeDraft()],
    outcomeRemovals: []
  }
}

export function emptyNextStepOutcomeDraft(): NextStepOutcomeDraft {
  return {
    id: crypto.randomUUID(),
    finish: null,
    instructions: '',
    steps: []
  }
}

export function nextStepReviewRepairProblem(
  step: NextStepOutcomeStep,
  previous: NextStepOutcomeStep | undefined
): string | null {
  if (step.kind !== 'handoff' || !step.reviewRepair) {
    return null
  }
  if (previous?.kind !== 'review') {
    return 'Place a repair agent immediately after its review, or turn off repair mode.'
  }
  return !Number.isInteger(previous.maxRounds) ||
    previous.maxRounds < 2 ||
    previous.maxRounds > NEXT_STEP_MAX_REVIEW_ROUNDS
    ? 'Choose between two and five review rounds when using a repair agent.'
    : null
}

export function nextStepReviewRoundsProblem(
  step: NextStepOutcomeStep,
  following: NextStepOutcomeStep | undefined
): string | null {
  return step.kind === 'review' &&
    step.maxRounds > 1 &&
    !step.repairWithSource &&
    !(following?.kind === 'handoff' && following.reviewRepair)
    ? 'Choose one report-only round, or enable repairs for additional rounds.'
    : null
}

export function nextStepOutcomeProblems(
  outcomes: readonly NextStepOutcomeDraft[] | undefined
): string[] {
  if (!outcomes || outcomes.length === 0) {
    return ['Define at least one finish.']
  }
  const seen = new Set<string>()
  const problems: string[] = []
  for (const outcome of outcomes) {
    if (!outcome.id || seen.has(outcome.id)) {
      problems.push('Each outcome needs a unique ID.')
    }
    seen.add(outcome.id)
    if (!outcome.finish) {
      problems.push('Define a finish for every outcome.')
      continue
    }
    if (
      outcome.revision === undefined &&
      outcome.steps.filter((step) => step.kind === 'handoff').length >
        NEXT_STEP_MAX_SEQUENTIAL_HANDOFFS
    ) {
      problems.push('Choose up to six sequential agent handoffs.')
    }
    for (const [index, step] of outcome.steps.entries()) {
      const repairProblem = nextStepReviewRepairProblem(step, outcome.steps[index - 1])
      if (repairProblem) {
        problems.push(repairProblem)
      }
      const roundsProblem = nextStepReviewRoundsProblem(step, outcome.steps[index + 1])
      if (roundsProblem) {
        problems.push(roundsProblem)
      }
      if (step.kind === 'review') {
        if (step.reviewers.length === 0) {
          problems.push('Choose at least one reviewer.')
        }
        if (step.reviewers.length > NEXT_STEP_MAX_REVIEWERS) {
          problems.push('Choose up to five reviewers.')
        }
        if (
          !Number.isInteger(step.maxRounds) ||
          step.maxRounds < 1 ||
          step.maxRounds > NEXT_STEP_MAX_REVIEW_ROUNDS
        ) {
          problems.push('Choose between one and five review rounds.')
        }
      }
      if (step.kind === 'handoff' && !step.actor) {
        problems.push('Choose the agent responsible for this handoff.')
      }
    }
    if (
      outcome.finish.kind === 'person' &&
      (!outcome.finish.personId || !outcome.finish.personName)
    ) {
      problems.push('Choose the person who receives this outcome.')
    }
    if (
      outcome.finish.kind === 'person' &&
      outcome.finish.disposition === 'ownership' &&
      (outcome.finish.people?.length ?? 1) > 1
    ) {
      problems.push('A handoff moves ownership to one person; use a review for several.')
    }
    if (
      outcome.finish.kind === 'person' &&
      outcome.finish.agentRecipient &&
      new TextEncoder().encode(outcome.instructions.trim()).length > 8192
    ) {
      problems.push(
        'The agent message exceeds 8,192 UTF-8 bytes. Shorten the finish instructions before saving.'
      )
    }
    if (outcome.finish.kind === 'github' && !outcome.finish.repository?.trim()) {
      problems.push('Choose the repository for this GitHub outcome.')
    }
    if (
      outcome.finish.kind === 'github' &&
      outcome.finish.action === 'merge-and-deploy' &&
      !outcome.finish.deploymentTarget?.trim()
    ) {
      problems.push('Choose a deployment target when it cannot be inferred.')
    }
  }
  return [...new Set(problems)]
}

export function nextStepAgents(draft: Pick<NextStepDraft, 'recipients'>): NextStepAgentRecipient[] {
  return draft.recipients.filter(
    (recipient): recipient is NextStepAgentRecipient => recipient.kind === 'agent'
  )
}

export function nextStepPeople(
  draft: Pick<NextStepDraft, 'recipients'>
): NextStepPersonRecipient[] {
  return draft.recipients.filter(
    (recipient): recipient is NextStepPersonRecipient => recipient.kind === 'person'
  )
}

/** One recipient is a plain handoff; several act in parallel after the same source. */
export function isNextStepParallel(draft: Pick<NextStepDraft, 'recipients'>): boolean {
  return draft.recipients.length > 1
}

/** Rounds stay a per-step choice; inside a fan-out every member runs once. */
export function nextStepRoundsAllowed(
  draft: Pick<NextStepDraft, 'recipients'>,
  recipient: NextStepAgentRecipient
): boolean {
  return (
    !isNextStepParallel(draft) &&
    recipient.presetId !== null &&
    NEXT_STEP_ROUND_PRESETS.includes(recipient.presetId)
  )
}

export function clampNextStepRounds(value: number): number {
  return Number.isInteger(value) ? Math.min(Math.max(value, 1), NEXT_STEP_MAX_ROUNDS) : 1
}
