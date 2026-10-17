import { assertOpenRouterRoute } from './openrouter-route'
import type { SessionActionPresetId } from './session-action-presets'
import {
  clampNextStepRounds,
  defaultNextStepInstructions,
  isNextStepParallel,
  nextStepAgents,
  nextStepPeople,
  type NextStepActor,
  type NextStepDraft,
  type NextStepHandoffOptions,
  type NextStepProblem
} from './next-step-draft'
import { compileNextOutcomeSteps, configuredNextStepOutcomes } from './next-outcome-compile'
import type { SessionReviewAssignment, SessionReviewRepairAssignment } from './session-chain-review'
import {
  sessionChainStepOutputDir,
  type SessionChainAgentStep,
  type SessionChainStep
} from './session-chain-types'
import {
  SESSION_FOLLOW_UP_MAX_MANIFESTS,
  SESSION_FOLLOW_UP_MAX_NAME_CHARS,
  SESSION_FOLLOW_UP_MAX_NOTE_CHARS,
  SESSION_FOLLOW_UP_MAX_RECIPIENTS,
  SESSION_FOLLOW_UP_MAX_TITLE_CHARS,
  type SessionChainHandoffStep,
  type SessionFollowUpDeliverables,
  type SessionFollowUpRule
} from './session-follow-up-rule'

export type NextStepCompileInput = {
  draft: NextStepDraft
  chainId: string
  workspacePath: string
  sessionLabel: string
  /** The note a people handoff carries when the person typed none; the hub needs a body. */
  defaultNote: string
  now: number
  mintStepId: (position: number) => string
  mintOperationId: () => string
  /**
   * Card-less handoffs are on (Settings → Experimental): a people step needs no task; the
   * request stands on its own. Off, a person is involved only through a task.
   */
  cardlessHandoffs?: boolean
  /** Fleet delivery receipts can release explicit later steps after people-first recipients. */
  allowAfterPeople?: boolean
}

const NOTE_MAX = SESSION_FOLLOW_UP_MAX_NOTE_CHARS
const TITLE_MAX = SESSION_FOLLOW_UP_MAX_TITLE_CHARS
const NAME_MAX = SESSION_FOLLOW_UP_MAX_NAME_CHARS

function clamp(value: string, max: number): string {
  return value.trim().slice(0, max).trim()
}

function agentStep(
  input: NextStepCompileInput,
  position: number,
  recipient: NextStepActor & {
    presetId: SessionActionPresetId | null
    instructions: string
  },
  extra: Pick<SessionChainAgentStep, 'group' | 'round' | 'role'> & {
    id?: string
    outcomeId?: string
    review?: SessionReviewAssignment
    reviewRepair?: SessionReviewRepairAssignment
  }
): SessionChainAgentStep {
  const instructions =
    recipient.instructions.trim() ||
    (recipient.presetId ? defaultNextStepInstructions(recipient.presetId) : '')
  assertOpenRouterRoute(recipient)
  return {
    id: extra.id ?? input.mintStepId(position),
    agent: recipient.agent,
    prompt: instructions,
    ...(recipient.presetId ? { presetId: recipient.presetId } : {}),
    ...(recipient.model ? { model: recipient.model } : {}),
    ...(recipient.openrouterCandidates
      ? { openrouterCandidates: [...recipient.openrouterCandidates] }
      : {}),
    ...(recipient.effort ? { effort: recipient.effort } : {}),
    ...(recipient.accountChoiceId ? { accountChoiceId: recipient.accountChoiceId } : {}),
    ...(extra.group ? { group: extra.group } : {}),
    ...(extra.round ? { round: extra.round } : {}),
    ...(extra.outcomeId ? { outcomeId: extra.outcomeId } : {}),
    ...(extra.role ? { role: extra.role } : {}),
    ...(extra.review ? { review: extra.review } : {}),
    ...(extra.reviewRepair ? { reviewRepair: extra.reviewRepair } : {}),
    status: 'queued'
  } as SessionChainAgentStep
}

function handoffStep(
  input: NextStepCompileInput,
  position: number,
  people: readonly { id: string; name: string }[],
  task: { id: string; title: string } | null,
  deliverables: SessionFollowUpDeliverables,
  includeSummary: boolean,
  group: string | undefined,
  review = false,
  id?: string
): SessionChainHandoffStep {
  const { handoff, note } = input.draft
  const { disposition, artifactReview } = handoff as NextStepHandoffOptions & {
    disposition?: SessionFollowUpRule['disposition']
  }
  const label = clamp(input.sessionLabel, TITLE_MAX)
  const rule: SessionFollowUpRule = {
    revision: 1,
    // Why: without a card the request is titled by the session; the hub thread carries that title.
    taskId: task?.id ?? null,
    taskTitle: task ? clamp(task.title, TITLE_MAX) || task.id : label,
    sessionLabel: label,
    recipients: people.map((person) => ({
      employeeId: person.id,
      name: clamp(person.name, NAME_MAX) || person.id,
      operationId: input.mintOperationId(),
      delivery: 'pending'
    })),
    ...(review ? { action: 'review' as const } : handoff.action ? { action: handoff.action } : {}),
    ...(disposition ? { disposition } : {}),
    ...(handoff.communicationType ? { communicationType: handoff.communicationType } : {}),
    ...(handoff.sourceConversationId ? { sourceConversationId: handoff.sourceConversationId } : {}),
    deliverables,
    ...(handoff.destinationDirectory ? { destinationDirectory: handoff.destinationDirectory } : {}),
    includeSummary,
    ...(handoff.includeTranscript && handoff.transcriptSource
      ? { transcriptSource: handoff.transcriptSource }
      : {}),
    note: clamp(note, NOTE_MAX) || clamp(input.defaultNote, NOTE_MAX),
    ...(input.draft.noteAuthored && clamp(note, NOTE_MAX) ? { noteAuthored: true as const } : {}),
    ...(handoff.dueAt ? { dueAt: handoff.dueAt } : {}),
    ...(artifactReview ? { artifactReview: { ...artifactReview } } : {}),
    savedAt: input.now
  }
  return {
    kind: 'handoff',
    id: id ?? input.mintStepId(position),
    ...(group ? { group } : {}),
    status: 'queued',
    handoff: rule
  }
}

/** What people receive from the source session: its manifest, named files, or the final summary. */
function sourceDeliverables(options: NextStepHandoffOptions): {
  deliverables: SessionFollowUpDeliverables
  includeSummary: boolean
} {
  if (options.deliverables) {
    return { deliverables: options.deliverables, includeSummary: options.includeSummary }
  }
  return { deliverables: { kind: 'files', paths: [] }, includeSummary: options.includeSummary }
}

/** What people receive after agent steps: the manifests those steps were told to write. */
function agentDeliverables(
  input: NextStepCompileInput,
  steps: readonly SessionChainAgentStep[]
): SessionFollowUpDeliverables {
  const manifestPaths = steps.map(
    (step) =>
      `${sessionChainStepOutputDir(input.workspacePath, input.chainId, step.id)}/manifest.md`
  )
  return manifestPaths.length === 1
    ? { kind: 'manifest', manifestPath: manifestPaths[0]! }
    : { kind: 'manifests', manifestPaths }
}

/**
 * Turn the draft into chain steps. One recipient: a single step. Several: one group
 * that acts after the same source. `then` adds the step that waits on the group's
 * agents. Problems name what still stops the draft; with any problem, no steps.
 */
export function compileNextStepChain(input: NextStepCompileInput): {
  steps: SessionChainStep[]
  problems: NextStepProblem[]
} {
  const { draft } = input
  const outcomes = configuredNextStepOutcomes(draft)
  if (outcomes.length > 0) {
    return compileNextOutcomeSteps({ input, outcomes, agentStep, handoffStep, sourceDeliverables })
  }
  const problems: NextStepProblem[] = []
  const agents = nextStepAgents(draft).map((agent) =>
    draft.mode === 'review' && !agent.presetId ? { ...agent, presetId: 'review' as const } : agent
  )
  const people = nextStepPeople(draft)
  if (draft.recipients.length === 0) {
    problems.push({ kind: 'no-recipients' })
  }
  for (const agent of agents) {
    if (!agent.presetId && !agent.instructions.trim()) {
      problems.push({ kind: 'agent-needs-action', key: agent.key })
    }
  }
  if (people.length > SESSION_FOLLOW_UP_MAX_RECIPIENTS) {
    problems.push({ kind: 'too-many-people' })
  }
  if (agents.length > SESSION_FOLLOW_UP_MAX_MANIFESTS) {
    problems.push({ kind: 'too-many-agents' })
  }
  const afterSteps =
    agents.length > 0 ||
    input.allowAfterPeople ||
    draft.after.some((step) => step.level !== undefined)
      ? draft.after
      : []
  if (draft.mode === 'handoff' && draft.recipients.length !== 1) {
    problems.push({ kind: 'handoff-needs-one-recipient' })
  }
  let level = 1
  const levels = new Map<number, typeof draft.after>()
  for (const step of afterSteps) {
    level = step.level ?? level + 1
    if (!Number.isInteger(level) || level < 2) {
      problems.push({ kind: 'invalid-level' })
    }
    if (level > 5) {
      problems.push({ kind: 'too-many-levels' })
    }
    levels.set(level, [...(levels.get(level) ?? []), step])
  }
  for (const members of levels.values()) {
    if (members.filter((step) => step.kind === 'agent').length > SESSION_FOLLOW_UP_MAX_MANIFESTS) {
      problems.push({ kind: 'too-many-agents' })
    }
    if (
      members.filter((step) => step.kind === 'person').length > SESSION_FOLLOW_UP_MAX_RECIPIENTS
    ) {
      problems.push({ kind: 'too-many-people' })
    }
  }
  if (afterSteps.some((step) => step.kind === 'person' && !step.id)) {
    problems.push({ kind: 'no-person' })
  }
  const wantsPerson = people.length > 0 || afterSteps.some((step) => step.kind === 'person')
  const task = draft.handoff.task
  if (wantsPerson && !task && !input.cardlessHandoffs) {
    problems.push({ kind: 'no-task' })
  }
  if (problems.length > 0) {
    return { steps: [], problems }
  }
  const parallel = isNextStepParallel(draft)
  const group = parallel ? 'g1' : undefined
  const steps: SessionChainStep[] = []
  const launched: SessionChainAgentStep[] = []
  for (const agent of agents) {
    const rounds = parallel ? 1 : clampNextStepRounds(agent.rounds)
    for (let index = 1; index <= rounds; index += 1) {
      const step = agentStep(input, steps.length + 1, agent, {
        group,
        ...(rounds > 1 ? { round: { key: agent.key, index, total: rounds } } : {})
      })
      steps.push(step)
      launched.push(step)
    }
  }
  if (people.length > 0 && (task || input.cardlessHandoffs)) {
    const source = sourceDeliverables(draft.handoff)
    steps.push(
      handoffStep(
        input,
        steps.length + 1,
        people,
        task,
        source.deliverables,
        source.includeSummary,
        group,
        draft.mode === 'review'
      )
    )
  }
  // Why: rounds already chain on themselves; what follows waits on the last round only.
  let feeders: SessionChainAgentStep[] = parallel ? launched : launched.slice(-1)
  for (const [level, members] of [...levels].sort(([a], [b]) => a - b)) {
    const group = members.length > 1 ? `g${level}` : undefined
    const outputs: SessionChainAgentStep[] = []
    for (const step of members) {
      if (step.kind === 'person') {
        const source = sourceDeliverables(draft.handoff)
        steps.push(
          handoffStep(
            input,
            steps.length + 1,
            [step],
            task,
            feeders.length ? agentDeliverables(input, feeders) : source.deliverables,
            feeders.length ? false : source.includeSummary,
            group,
            step.action === 'review' || members.length > 1
          )
        )
        continue
      }
      const rounds = group ? 1 : clampNextStepRounds(step.rounds)
      for (let index = 1; index <= rounds; index += 1) {
        const next = agentStep(
          input,
          steps.length + 1,
          { ...step.actor, presetId: step.presetId, instructions: step.instructions },
          { group, ...(rounds > 1 ? { round: { key: step.key, index, total: rounds } } : {}) }
        )
        steps.push(next)
        if (index === rounds) {
          outputs.push(next)
        }
      }
    }
    if (outputs.length) {
      feeders = outputs
    }
  }
  return { steps, problems }
}
