import type { WorkflowProgramCall, WorkflowProgramContext } from '../workflow-program-context'
import areasSchema from './schemas/discovery-areas-v7.schema.json'
import findingsSchema from './schemas/findings-v7.schema.json'
import verdictSchema from './schemas/verdict-files-v7.schema.json'
import reportSchema from './schemas/discovery-report-v7.schema.json'
import repeatsSchema from './schemas/discovery-repeats-v7.schema.json'
import {
  DISCOVER_V7_VERIFY_LENSES,
  discoverV7RepeatCallId,
  discoverV7VerifyCallId,
  type DiscoverV7Area,
  type DiscoverV7Plan,
  type DiscoverV7Record,
  type DiscoverV7RoundJob,
  type DiscoverV7Vote
} from './discover-v7-plan'
import {
  discoverV7FindPrompt,
  discoverV7RankPrompt,
  discoverV7RepeatPrompt,
  discoverV7ScoutPrompt,
  discoverV7VerifyPrompt
} from './discover-v7-prompts'
import { discoverV7RankProblem } from './discover-v7-report'
import {
  discoverV7FilesReadProblem,
  discoverV7FindingsProblem,
  discoverV7RepeatsProblem,
  discoverV7VoteProblem
} from './discover-v7-validate'

type Task = { prompt: string; evidence: string }
export type DiscoverV7Verified = {
  record: DiscoverV7Record
  votes: (DiscoverV7Vote | null)[]
  duplicates: readonly DiscoverV7Record[]
}

const MINUTE = 60_000
/** A vote's process timeout; admission judges which accounts a vote would queue on with it. */
export const DISCOVER_V7_VERIFY_TIMEOUT_MS = 10 * MINUTE
// The checkpoint store never allows more than three persisted attempts for one call.
const MAX_PERSISTED_ATTEMPTS = 3

/**
 * Runs a call until it returns or its persisted attempts run out, so a null result is final: a
 * later Resume or Retry replays the same null and no decision built on it can change the
 * identity of calls already recorded. When admission closes part way (pause or stop), nothing
 * after this point can be recorded either, so the next run decides again from scratch.
 */
export async function lastingDiscoverV7Agent(
  context: WorkflowProgramContext,
  call: WorkflowProgramCall
): Promise<unknown> {
  for (let tries = 0; tries < MAX_PERSISTED_ATTEMPTS; tries++) {
    const [value] = await context.parallel([() => context.agent(call)])
    if (value !== null && value !== undefined) {
      return value
    }
  }
  return null
}

function scoutProblem(value: unknown): string | null {
  const names = (value as { areas: DiscoverV7Area[] }).areas.map((area) =>
    area.name.trim().toLowerCase()
  )
  return new Set(names).size === names.length ? null : 'Area names must be unique'
}

export function discoverV7ScoutCall(plan: DiscoverV7Plan, task: Task): WorkflowProgramCall {
  return {
    id: 'scout/map',
    seatId: plan.config.rankerId,
    schema: areasSchema,
    dependencies: [],
    prompt: discoverV7ScoutPrompt(plan.config, task),
    validateSemantics: scoutProblem,
    timeoutMs: 10 * MINUTE
  }
}

export function discoverV7FindCall(
  plan: DiscoverV7Plan,
  task: Task,
  areas: readonly DiscoverV7Area[],
  job: DiscoverV7RoundJob,
  known: readonly DiscoverV7Record[]
): WorkflowProgramCall {
  return {
    id: job.callId,
    seatId: job.seatId,
    schema: findingsSchema,
    dependencies: ['scout/map'],
    prompt: discoverV7FindPrompt(plan.config, task, areas[job.areaIndex], job, known),
    validateSemantics: (value) => {
      const { access, workspaceRoot } = plan.config
      const problems = [
        access === 'workspace-read'
          ? discoverV7FilesReadProblem(value, areas[job.areaIndex], workspaceRoot)
          : null,
        discoverV7FindingsProblem(value, workspaceRoot)
      ].filter((problem): problem is string => problem !== null)
      return problems.length ? problems.join(' ') : null
    },
    timeoutMs: 20 * MINUTE
  }
}

/** One call per round on the ranker seat; it runs once every finder of the round has answered. */
export function discoverV7RepeatCall(
  plan: DiscoverV7Plan,
  task: Task,
  jobs: readonly DiscoverV7RoundJob[],
  candidates: readonly DiscoverV7Record[]
): WorkflowProgramCall {
  const ids = candidates.map((record) => record.id)
  const round = jobs[0].round
  return {
    id: discoverV7RepeatCallId(round),
    seatId: plan.config.rankerId,
    schema: repeatsSchema,
    dependencies: jobs.map((job) => job.callId),
    prompt: discoverV7RepeatPrompt(plan.config, task, round, candidates),
    validateSemantics: (value) => discoverV7RepeatsProblem(value, ids),
    timeoutMs: 10 * MINUTE
  }
}

export function discoverV7VerifyCall(
  plan: DiscoverV7Plan,
  task: Task,
  record: DiscoverV7Record,
  lensIndex: number
): WorkflowProgramCall {
  const lens = DISCOVER_V7_VERIFY_LENSES[lensIndex]
  return {
    id: discoverV7VerifyCallId(record.id, lens),
    seatId: record.verifiers![lensIndex],
    schema: verdictSchema,
    dependencies: [record.findCallId],
    prompt: discoverV7VerifyPrompt(plan.config, task, record, lens),
    validateSemantics: (value) => discoverV7VoteProblem(value, plan.config.access),
    timeoutMs: DISCOVER_V7_VERIFY_TIMEOUT_MS
  }
}

export function discoverV7RankCall(
  plan: DiscoverV7Plan,
  task: Task,
  ledger: {
    confirmed: readonly DiscoverV7Verified[]
    refuted: readonly DiscoverV7Record[]
    unverified: readonly DiscoverV7Record[]
  }
): WorkflowProgramCall {
  const confirmedIds = ledger.confirmed.map(({ record }) => record.id)
  return {
    id: 'rank/final',
    seatId: plan.config.rankerId,
    schema: reportSchema,
    dependencies: confirmedIds.flatMap((id) =>
      DISCOVER_V7_VERIFY_LENSES.map((lens) => discoverV7VerifyCallId(id, lens))
    ),
    prompt: discoverV7RankPrompt(
      plan.config,
      task,
      ledger.confirmed,
      ledger.refuted,
      ledger.unverified
    ),
    validateSemantics: (value) => discoverV7RankProblem(value, confirmedIds),
    timeoutMs: 10 * MINUTE
  }
}
