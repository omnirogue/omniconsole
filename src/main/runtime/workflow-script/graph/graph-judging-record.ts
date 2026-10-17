import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getAppEnvironment } from '../../../../shared/app-environment'
import type { ContractRef } from '../../../../shared/decision-contracts/decision-contract-types'
import { JEV_DEFAULT_RUBRIC } from '../../../../shared/jev-rubric'
import type { JevUsage } from '../../../structured-decisions/jev-certainty'
import type { GraphJevJudgment } from './graph-jev'
import { graphJudgeAgreement } from './graph-judge-agreement'
import type { GraphJudgingGate } from './graph-judging-gates'
import type {
  GraphCallView,
  GraphConfig,
  GraphOutcome,
  GraphPlan,
  GraphTask
} from './graph-plan-types'

/**
 * The judging record: one line per judged round of every Rank step, kept on this computer. It says
 * which model and system prompt wrote each answer, where each answer placed, what JEV and the
 * model judges said, and whether they agreed — the evidence for learning which seats win and
 * where JEV can be trusted alone. Nothing in the app reads it back to change a seat, a rubric
 * or a threshold: `omni workflow stats` only reports it.
 */
export type GraphJudgingEntry = {
  /** Absent on lines written before gate lines existed; a line without `kind` is a Rank round. */
  kind?: 'rank'
  at: number
  executionId: string
  template: string
  stepId: string
  round: number
  taskDigest: string
  taskPreview: string
  rubricDigest: string
  /** Digest of the rubric JEV was actually sent: the instruction it saw, else the default rubric. */
  jevRubricDigest?: string
  /** The decision contract the JEV request named (frozen at admission); absent on older runs. */
  contract?: ContractRef
  /** Improve instructions the person reworded, and a digest of that wording, to compare later. */
  prompts?: { custom: string[]; digest: string }
  candidates: {
    label: string
    route: string
    model?: string
    systemDigest?: string
    systemPreview?: string
    place?: number
    votes?: number
    won: boolean
    /** Improve's best version defending its place: its seat's win is not a new answer's. */
    incumbent?: true
  }[]
  /** `counted`: false when an unsure JEV stood aside and the model judges decided. */
  jev?: {
    ranking: string[]
    unsure: boolean
    counted: boolean
    method?: GraphJevJudgment['method']
    usage?: JevUsage
    unsureReason?: string
    durationMs?: number
  }
  /** JEV was asked and gave no ballot, so the model judges ranked alone. */
  jevFailed?: true
  models: { route: string; model?: string; ranking: string[] }[]
  agreement?: { topSame: boolean; pairs: number }
}

/** One line of the record: a Rank round, or a gate JEV decided (graph-judging-gates.ts). */
export type GraphJudgingLine = GraphJudgingEntry | GraphJudgingGate

export const graphJudgingDigest = (text: string) =>
  createHash('sha256').update(text).digest('hex').slice(0, 16)

function promptsRecord(config: GraphConfig): GraphJudgingEntry['prompts'] {
  const prompts = config.spec.repeat?.prompts
  return prompts && Object.keys(prompts).length
    ? { custom: Object.keys(prompts).sort(), digest: graphJudgingDigest(JSON.stringify(prompts)) }
    : undefined
}

/** What a kept JEV ballot says about itself, from its outcome; nothing when it gave none. */
export function graphJevJudgmentOf(
  outcome: GraphOutcome | undefined
): Pick<NonNullable<GraphJudgingEntry['jev']>, 'method' | 'usage' | 'unsureReason' | 'durationMs'> {
  const value =
    outcome && 'value' in outcome ? (outcome.value as { judgment?: GraphJevJudgment } | null) : null
  const judgment = value?.judgment
  if (!judgment || typeof judgment !== 'object') {
    return {}
  }
  return {
    ...(judgment.method ? { method: judgment.method } : {}),
    ...(judgment.usage ? { usage: judgment.usage } : {}),
    ...(judgment.unsureReason ? { unsureReason: judgment.unsureReason } : {}),
    ...(typeof judgment.durationMs === 'number' ? { durationMs: judgment.durationMs } : {})
  }
}

/** The JEV request behind a round's ballot view, as the plan built it: what JEV actually saw. */
export function graphJevRequestOf(plan: GraphPlan, view: GraphCallView | undefined) {
  return view ? plan.calls.find((call) => call.id === view.id)?.jev : undefined
}

export function graphJudgingEntries(
  config: GraphConfig,
  task: GraphTask,
  plan: GraphPlan,
  executionId: string,
  at: number,
  outcomes: ReadonlyMap<string, GraphOutcome> = new Map()
): GraphJudgingEntry[] {
  const seat = (seatId: string) => config.seats.find((entry) => entry.id === seatId)
  const byId = new Map(config.spec.steps.map((step) => [step.id, step]))
  const prompts = promptsRecord(config)
  return config.spec.steps
    .filter((step) => step.kind === 'rank')
    .flatMap((step) =>
      (plan.runs[step.id] ?? [])
        // A comparison's overall round has no judges of its own: its lines are recorded instead.
        .filter((run) => run.calls.length > 0 && (run.standings ?? []).some((row) => row.votes > 0))
        .map((run) => {
          const candidates = run.candidates ?? []
          const jevCall = run.calls.find((view) => view.jev)
          const jevView = run.calls.find((view) => view.jev && view.ranking)
          const request = graphJevRequestOf(plan, jevCall)
          const agreement = graphJudgeAgreement(run, candidates)
          const modelsRanked = run.calls.some((view) => !view.jev && view.ranking)
          return {
            kind: 'rank' as const,
            at,
            executionId,
            template: config.spec.template,
            stepId: step.id,
            round: run.round,
            taskDigest: graphJudgingDigest(task.prompt),
            taskPreview: task.prompt.slice(0, 200),
            rubricDigest: graphJudgingDigest(step.instruction),
            ...(request
              ? {
                  jevRubricDigest: graphJudgingDigest(
                    request.instruction.trim() || JEV_DEFAULT_RUBRIC
                  )
                }
              : {}),
            ...(request?.contract ? { contract: request.contract } : {}),
            ...(prompts ? { prompts } : {}),
            candidates: candidates.map((candidate) => {
              const standing = run.standings?.find((row) => row.label === candidate.label)
              const system = candidate.source
                ? byId.get(candidate.source.stepId)?.agents[candidate.source.agentIndex]?.system
                : undefined
              const model = seat(candidate.seatId)?.model
              return {
                label: candidate.label,
                route: seat(candidate.seatId)?.agent ?? candidate.seatId,
                ...(model ? { model } : {}),
                ...(system
                  ? {
                      systemDigest: graphJudgingDigest(system),
                      systemPreview: system.slice(0, 120)
                    }
                  : {}),
                ...(standing?.votes ? { place: standing.place, votes: standing.votes } : {}),
                won: !!standing?.votes && standing.place === 1,
                ...(candidate.incumbent ? { incumbent: true as const } : {})
              }
            }),
            ...(jevView
              ? {
                  jev: {
                    ranking: jevView.ranking!,
                    unsure: !!run.jevUnsure,
                    counted: !run.jevUnsure || !!run.jevCounted || !modelsRanked,
                    ...graphJevJudgmentOf(outcomes.get(jevView.id))
                  }
                }
              : {}),
            ...(jevCall && !jevView && jevCall.status === 'failed' && !jevCall.skipped
              ? { jevFailed: true as const }
              : {}),
            models: run.calls
              .filter((view) => !view.jev && view.ranking)
              .map((view) => ({
                route: seat(view.seatId)?.agent ?? view.seatId,
                ...(seat(view.seatId)?.model ? { model: seat(view.seatId)!.model } : {}),
                ranking: view.ranking!
              })),
            ...(agreement ? { agreement } : {})
          }
        })
    )
}

/**
 * Records a settled run's judging once: the run's own copy beside its attempts, and one line per
 * round or gate in the shared record (`workflow-judging.jsonl`), appended only the first time.
 */
export function recordGraphJudging(
  lines: GraphJudgingLine[],
  executionId: string,
  root = join(getAppEnvironment().getPath('userData'), 'local-workflow-attempts')
): void {
  if (!lines.length || !/^[A-Za-z0-9_-]{1,128}$/.test(executionId)) {
    return
  }
  const own = join(root, executionId, 'judging.json')
  const first = !existsSync(own)
  mkdirSync(dirname(own), { recursive: true })
  writeFileSync(own, JSON.stringify(lines), { mode: 0o600 })
  if (first) {
    appendFileSync(
      join(root, 'workflow-judging.jsonl'),
      `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
      { mode: 0o600 }
    )
  }
}
