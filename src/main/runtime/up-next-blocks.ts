/**
 * The chain and the prompt queue, read as Up next blocks.
 *
 * One block per thing that will actually happen, in the order it will happen: the
 * person's queued prompts to the agent they are talking to, then this plan version's
 * stages (one block per plan node, its seats folded into it), then the people, then
 * Done. Nothing is invented — a field the runtime cannot answer is left out rather
 * than filled with a plausible number.
 */

import {
  hasSessionFollowUpStartedDelivery,
  sessionFollowUpDisposition,
  type SessionChainHandoffStep
} from '../../shared/session-follow-up-rule'
import { isPromptQueueEntrySettled, type PromptQueue } from '../../shared/prompt-queue-types'
import { stripNextOutcomeOutputInstruction } from '../../shared/next-outcome-compile'
import { sessionRunDispositionIntent } from '../../shared/session-run-completion'
import { readSessionRun } from '../../shared/session-run-lifecycle'
import type { SessionChain, SessionChainAgentStep } from '../../shared/session-chain-types'
import {
  UP_NEXT_BLOCK_ID,
  UP_NEXT_DONE_BLOCK_ID,
  type UpNextAgentBlock,
  type UpNextAgentTemplate,
  type UpNextBlock,
  type UpNextDoneBlock,
  type UpNextPersonBlock,
  type UpNextPromptBlock
} from '../../shared/up-next-types'
import { upNextAgentIntent, upNextStageOutput } from '../../shared/up-next-agent-intent'
import { decideSessionOutcomeHandoffRecovery } from './session-outcome-handoff-recovery'
import { upNextStepReading } from './up-next-step-state'

// The output and the review/handoff intent are one derivation, shared with the renderer.
export { upNextStageOutput } from '../../shared/up-next-agent-intent'

/**
 * The prompts a stage is holding, as blocks nested under it. Read from the stage's FIRST
 * seat: every seat of a fan-out carries the same instruction, and the person wrote it once.
 */
function stagePromptBlocks(blockId: string, seat: SessionChainAgentStep): UpNextPromptBlock[] {
  return (seat.prompts ?? [])
    .filter((prompt) => prompt.state !== 'delivered')
    .map((prompt) => ({
      id: `${UP_NEXT_BLOCK_ID.stagePrompt}${seat.id}:${prompt.id}`,
      kind: 'prompt',
      state:
        prompt.state === 'sending' ? 'running' : prompt.state === 'failed' ? 'failed' : 'queued',
      number: '',
      locked: prompt.state === 'sending',
      text: prompt.text,
      target: { kind: 'stage', blockId }
    }))
}

/** Waiting, in-flight and failed prompts. A delivered prompt is in the transcript. */
export function upNextPromptBlocks(queue: PromptQueue | null): UpNextPromptBlock[] {
  return (queue?.entries ?? [])
    .filter((entry) => !isPromptQueueEntrySettled(entry) || entry.state === 'failed')
    .map((entry) => ({
      id: `${UP_NEXT_BLOCK_ID.promptQueue}${entry.id}`,
      kind: 'prompt',
      // A queued entry waits for the turn to end; that IS "after current work".
      state: entry.state === 'sending' ? 'running' : entry.state === 'failed' ? 'failed' : 'queued',
      number: '',
      locked: entry.state === 'sending',
      text: entry.text,
      target: { kind: 'current' },
      when: 'after',
      queueEntryId: entry.id,
      ...(entry.state === 'failed' && entry.reason ? { failureReason: entry.reason } : {}),
      ...(entry.holdsQueue ? { holdsQueue: true as const } : {})
    }))
}

/** The seats of one plan node, oldest first. A repair seat and later rounds fold in. */
function nodeSeats(steps: readonly SessionChainAgentStep[], node: string): SessionChainAgentStep[] {
  return steps.filter((step) => (step.planNodeId ?? step.id) === node && !step.reviewRepair)
}

/**
 * Every seat of one COMPOSER stage. A shape may have compiled to several nodes — a council
 * is answers ×N → critiques ×N → judge → winner — and the person chose one stage, so they
 * see and edit one block: the extra nodes are its convergence, reported inside it.
 */
function stageSteps(
  steps: readonly SessionChainAgentStep[],
  head: SessionChainAgentStep
): SessionChainAgentStep[] {
  const stage = head.stage?.id
  return stage
    ? steps.filter((step) => step.stage?.id === stage && !step.reviewRepair)
    : nodeSeats(steps, head.planNodeId ?? head.id)
}

function agentBlock(
  chain: SessionChain,
  stage: readonly SessionChainAgentStep[],
  primary: readonly SessionChainAgentStep[],
  blockIdOf: (stepId: string) => string | undefined,
  now: number
): UpNextAgentBlock {
  const head = primary[0]!
  const template: UpNextAgentTemplate = head.presetId ?? 'custom'
  // The whole stage decides the state: it is running while its judge runs, and done only
  // when every seat and every convergence node of it has finished.
  const reading = upNextStepReading(chain, stage, now)
  const rounds = head.review?.maxRounds
  // A review node's seats include every round; its WIDTH is one round of reviewers.
  const width =
    head.stage?.width ??
    (head.review
      ? primary.filter((seat) => (seat.review?.round ?? 1) === 1).length
      : primary.length)
  const seatIds = new Set(primary.map((seat) => seat.id))
  const progress = reading.progress
    ? {
        ...reading.progress,
        ...(reading.progress.seats
          ? { seats: reading.progress.seats.filter((seat) => seatIds.has(seat.id)) }
          : {})
      }
    : undefined
  const readsFrom = (head.readsFrom ?? []).map(blockIdOf).filter((id): id is string => Boolean(id))
  return {
    id: `${UP_NEXT_BLOCK_ID.planNode}${head.planNodeId ?? head.id}`,
    kind: 'agent',
    state: reading.state,
    number: '',
    locked: reading.locked,
    stepId: head.id,
    template,
    shape: head.stage?.shape ?? (width > 1 ? 'parallel' : 'solo'),
    n: width,
    instruction: stripNextOutcomeOutputInstruction(
      head.prompt,
      chain.workspacePath,
      chain.id,
      head.id
    ),
    output: upNextStageOutput(template),
    intent: upNextAgentIntent(template),
    advanced: {
      ...(head.model ? { model: head.model } : {}),
      ...(head.effort ? { effort: head.effort } : {}),
      ...(rounds && rounds > 1 ? { rounds, stopWhen: 'zero_blockers' as const } : {}),
      ...(readsFrom.length ? { readsFrom: [...new Set(readsFrom)] } : {})
    },
    ...(progress ? { progress } : {}),
    promptCount: 0
  }
}

/** "Jordan Taylor" → "SG"; one name gives its first two letters. */
export function initialsOf(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean)
  return (parts.length > 1 ? `${parts[0]![0]!}${parts.at(-1)![0]!}` : (parts[0]?.slice(0, 2) ?? ''))
    .toUpperCase()
    .slice(0, 2)
}

/**
 * A send that did not go out says so from the host's own recovery reading: `recovering` while
 * the host resends it by itself, `failed` once only the person's Resume can. It is a fact beside
 * the block's state, never the state itself: a send that failed before capture is still queued
 * work the person may remove (`upNextRecommitWithout`).
 */
function sendFailure(
  step: SessionChainHandoffStep,
  now: number
): UpNextPersonBlock['sendFailure'] | null {
  if (step.status === 'delivered') {
    return null
  }
  const recovery = decideSessionOutcomeHandoffRecovery(step.handoff, now)
  return recovery.kind === 'none' ? null : recovery.kind === 'fail' ? 'failed' : 'recovering'
}

function personBlock(step: SessionChainHandoffStep, now: number): UpNextPersonBlock {
  const rule = step.handoff
  const relationship = sessionFollowUpDisposition(rule) === 'feedback' ? 'review' : 'handoff'
  const started = hasSessionFollowUpStartedDelivery(rule)
  const reached = rule.recipients.filter((recipient) => recipient.delivery === 'sent')
  const sent = reached.flatMap((recipient) =>
    typeof recipient.at === 'number' ? [recipient.at] : []
  )
  const failure = sendFailure(step, now)
  const state =
    step.status === 'delivered'
      ? relationship === 'handoff'
        ? 'done'
        : 'waiting'
      : started
        ? 'running'
        : 'queued'
  return {
    id: `${UP_NEXT_BLOCK_ID.step}${step.id}`,
    kind: 'person',
    state,
    number: '',
    locked: started || state === 'done',
    stepId: step.id,
    relationship,
    people: rule.recipients.map((recipient) => ({
      id: recipient.employeeId,
      name: recipient.name,
      initials: initialsOf(recipient.name)
    })),
    receive: {
      files:
        rule.includeSummary ||
        rule.deliverables.kind !== 'files' ||
        rule.deliverables.paths.length > 0,
      transcript: Boolean(rule.transcriptSource),
      ...(rule.note ? { note: rule.note } : {}),
      // A handoff is not a task: a card exists only because one was asked for.
      createTaskCard: false,
      ...(rule.taskId ? { attachTaskId: rule.taskId } : {}),
      ...(rule.dueAt ? { dueAt: rule.dueAt } : {}),
      ...(rule.artifactReview ? { artifact: { ...rule.artifactReview } } : {})
    },
    ...(step.status === 'delivered' && sent.length ? { sentAt: Math.max(...sent) } : {}),
    ...(failure ? { sendFailure: failure } : {}),
    // Delivery goes one person at a time, so a failed send may already be in someone's hands.
    ...(failure && reached.length
      ? { reachedIds: reached.map((recipient) => recipient.employeeId) }
      : {})
  }
}

/**
 * The finish the person CHOSE, as the terminal block. No explicit terminal action — an absent
 * finish, or the legacy `me` — is Completed: nothing is closed, so there is no Done block to show
 * (`sessionRunDispositionIntent`). A finished run reads "closed" or "saved" only from the
 * disposition a window reported applied, never from the run having finished.
 */
function doneBlock(chain: SessionChain, now: number): UpNextDoneBlock | null {
  const set = chain.outcomeSet
  const finish = set?.sessionFinish
  if (!set || !finish) {
    return null
  }
  const { intent, folderId } = sessionRunDispositionIntent(finish)
  if (intent === 'completed') {
    return null
  }
  const run = readSessionRun(set, { now, planVersion: chain.planVersion ?? 1 })
  const complete = run.phase === 'completed'
  const applied =
    complete && run.disposition?.intent === intent && run.disposition.state === 'applied'
      ? run.disposition.appliedAt
      : undefined
  return {
    id: UP_NEXT_DONE_BLOCK_ID,
    kind: 'done',
    state: complete ? 'done' : 'queued',
    number: '',
    locked: complete,
    finish: intent,
    ...(folderId ? { folderId } : {}),
    ...(applied !== undefined
      ? intent === 'close'
        ? { closedAt: applied }
        : { savedAt: applied }
      : {})
  }
}

/**
 * What the chain is pursuing now, plus what it already finished, IN THE ORDER IT WILL RUN.
 *
 * The order is the Outcome's own `stepIds`, because that is what the host's barrier reads
 * (`advanceSessionOutcomeSteps` takes the first incomplete step of that list) — so a stage
 * the person anchored between two queued stages is shown where it will actually run, not
 * where it happened to be appended to the chain's step array.
 */
function currentSteps(chain: SessionChain): SessionChain['steps'] {
  const version = chain.planVersion ?? 1
  const completed = chain.outcomeSet?.completedSteps ?? []
  const order = chain.outcomeSet?.outcomes.flatMap((outcome) => outcome.stepIds ?? []) ?? []
  const rank = (step: SessionChain['steps'][number]): number => {
    const index = order.indexOf(step.id)
    return index === -1 ? order.length : index
  }
  return chain.steps
    .filter((step) => {
      if (step.supersededBy || step.status === 'skipped') {
        return false
      }
      return (
        (step.planVersion ?? 1) === version ||
        // Changing strategy does not unmake what was already produced, or unsend a request
        // that reached people: both stay in the list as the history above the Now row.
        completed.includes(step.id) ||
        (step.kind === 'handoff' && step.status === 'delivered')
      )
    })
    .map((step, index) => ({ step, index }))
    .toSorted((left, right) => rank(left.step) - rank(right.step) || left.index - right.index)
    .map((entry) => entry.step)
}

export function upNextChainBlocks(chain: SessionChain | null, now: number): UpNextBlock[] {
  if (!chain) {
    return []
  }
  const steps = currentSteps(chain)
  const agents = steps.filter((step): step is SessionChainAgentStep => step.kind !== 'handoff')
  const blockIdOf = (stepId: string): string | undefined => {
    const step = agents.find((candidate) => candidate.id === stepId)
    return step ? `${UP_NEXT_BLOCK_ID.planNode}${step.planNodeId ?? step.id}` : undefined
  }
  const blocks: UpNextBlock[] = []
  const seen = new Set<string>()
  for (const step of steps) {
    if (step.kind === 'handoff') {
      blocks.push(personBlock(step, now))
      continue
    }
    const key = step.stage?.id ?? step.planNodeId ?? step.id
    if (seen.has(key) || step.reviewRepair) {
      continue
    }
    seen.add(key)
    const primary = nodeSeats(agents, step.planNodeId ?? step.id)
    const block = agentBlock(chain, stageSteps(agents, step), primary, blockIdOf, now)
    blocks.push(block, ...stagePromptBlocks(block.id, primary[0]!))
  }
  // "Ends session on pass" is the plan's own finish (`how: 'complete'`, which the Outcome
  // records as `finish`), so it is a fact about the stage that ends the track.
  const last = blocks.findLast((block): block is UpNextAgentBlock => block.kind === 'agent')
  if (last && chain.outcomeSet?.outcomes[0]?.finish === 'complete') {
    last.advanced = { ...last.advanced, endOnSuccess: true }
  }
  const done = doneBlock(chain, now)
  return done ? [...blocks, done] : blocks
}
