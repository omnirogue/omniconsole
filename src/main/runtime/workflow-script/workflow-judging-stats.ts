import { join } from 'node:path'
import { getAppEnvironment } from '../../../shared/app-environment'
import {
  WORKFLOW_JUDGING_STATS_NOTE,
  type Known,
  type WorkflowJudgingDecision,
  type WorkflowJudgingGateRow,
  type WorkflowJudgingGroup,
  type WorkflowJudgingJudges,
  type WorkflowJudgingSeat,
  type WorkflowJudgingStats,
  type WorkflowJudgingStatsRequest,
  type WorkflowJudgingSum,
  type WorkflowJudgingTokens
} from '../../../shared/workflow-judging-stats'
import { DECISION_EXPERIMENT_TARIFF } from '../../structured-decisions/decision-experiment-metrics'
import { graphGateVerifyTotals, type GraphJudgingGate } from './graph/graph-judging-gates'
import type { GraphJudgingEntry } from './graph/graph-judging-record'
import { isGateLine, readJudgingLines } from './workflow-judging-stats-read'

/**
 * The judging record summed up, and nothing more: which seats win under which rubric, how often
 * JEV decides alone, escalates or fails, and what its ballots cost. Read-only by design. Nothing
 * may read these numbers back to pick a seat, a rubric or a threshold: a judge that is tuned
 * against gets gamed, and the wins here are the judges' view of the answers, not real results.
 */

type Tokens = { input: number; output: number; rounds: number }
type Sum = { total: number; rounds: number }

type GroupAccumulator = {
  template: string
  stepId: string
  decision: WorkflowJudgingDecision
  judgedBy: WorkflowJudgingJudges
  rounds: number
  wins: Record<string, number>
  defences: number
  alone: number
  escalated: number
  failed: number
  /** False once any line cannot say whether JEV was asked: the column is then unknown. */
  failedKnown: boolean
  countedWhileUnsure: number
  agreement: { rounds: number; topSame: number }
  tokens: Tokens
  ms: Sum
  modelJudgeCalls: number
  first: number
  last: number
}

type GateAccumulator = {
  template: string
  stepId: string
  gate: string
  contract: Known<string>
  count: number
  decisions: Record<string, number>
  jevFailed: number
  /** Live JEV verify: items it confirmed and set aside, each absent until a line counts it. */
  verify?: ReturnType<typeof graphGateVerifyTotals>
  tokens: Tokens
  ms: Sum
}

type SeatAccumulator = WorkflowJudgingSeat

const tariff = DECISION_EXPERIMENT_TARIFF

/** JEV's price for the tokens the record has; unknown when no round recorded any. */
function usdOf(tokens: Tokens): Known<number> {
  if (!tokens.rounds) {
    return 'unknown'
  }
  const usd =
    (tokens.input * tariff.inputUsdPerMillion + tokens.output * tariff.outputUsdPerMillion) /
    1_000_000
  return Math.round(usd * 1_000_000) / 1_000_000
}

const knownTokens = (tokens: Tokens): Known<WorkflowJudgingTokens> =>
  tokens.rounds ? tokens : 'unknown'
const knownSum = (sum: Sum): Known<WorkflowJudgingSum> => (sum.rounds ? sum : 'unknown')

function addTokens(
  tokens: Tokens,
  usage: { inputTokens: number; outputTokens: number } | undefined
) {
  if (usage) {
    tokens.input += usage.inputTokens
    tokens.output += usage.outputTokens
    tokens.rounds++
  }
}

function addMs(sum: Sum, durationMs: number | undefined) {
  if (typeof durationMs === 'number') {
    sum.total += durationMs
    sum.rounds++
  }
}

const count = (table: Record<string, number>, key: string) => {
  table[key] = (table[key] ?? 0) + 1
}

function decisionOf(line: GraphJudgingEntry): WorkflowJudgingDecision {
  if (line.contract) {
    return { contract: line.contract }
  }
  const digest = line.jevRubricDigest ?? line.rubricDigest
  return typeof digest === 'string' && digest ? { rubricDigest: digest } : 'unknown'
}

const decisionKey = (decision: WorkflowJudgingDecision) =>
  decision === 'unknown'
    ? 'unknown'
    : 'contract' in decision
      ? `contract:${decision.contract}`
      : `rubric:${decision.rubricDigest}`

function judgesOf(line: GraphJudgingEntry): WorkflowJudgingJudges {
  return line.jev ? (line.models.length ? 'jev and models' : 'jev') : 'models'
}

function addRound(groups: Map<string, GroupAccumulator>, line: GraphJudgingEntry): void {
  const decision = decisionOf(line)
  const judgedBy = judgesOf(line)
  const key = [line.template, line.stepId, decisionKey(decision), judgedBy].join('|')
  let group = groups.get(key)
  if (!group) {
    group = {
      template: line.template,
      stepId: line.stepId,
      decision,
      judgedBy,
      rounds: 0,
      wins: {},
      defences: 0,
      alone: 0,
      escalated: 0,
      failed: 0,
      failedKnown: true,
      countedWhileUnsure: 0,
      agreement: { rounds: 0, topSame: 0 },
      tokens: { input: 0, output: 0, rounds: 0 },
      ms: { total: 0, rounds: 0 },
      modelJudgeCalls: 0,
      first: line.at,
      last: line.at
    }
    groups.set(key, group)
  }
  group.rounds++
  const winner = line.candidates.find((candidate) => candidate.won)
  if (winner?.incumbent) {
    group.defences++
  } else if (winner) {
    count(group.wins, winner.route)
  }
  const { jev } = line
  if (jev && jev.counted && !line.models.length) {
    group.alone++
  }
  if (jev?.unsure && line.models.length) {
    group.escalated++
  }
  if (jev?.unsure && jev.counted) {
    group.countedWhileUnsure++
  }
  if (line.jevFailed) {
    group.failed++
  } else if (!jev) {
    group.failedKnown = false
  }
  if (line.agreement) {
    group.agreement.rounds++
    group.agreement.topSame += line.agreement.topSame ? 1 : 0
  }
  addTokens(group.tokens, jev?.usage)
  addMs(group.ms, jev?.durationMs)
  group.modelJudgeCalls += line.models.length
  group.first = Math.min(group.first, line.at)
  group.last = Math.max(group.last, line.at)
}

function addSeats(seats: Map<string, SeatAccumulator>, line: GraphJudgingEntry): void {
  for (const candidate of line.candidates) {
    const model = candidate.model ?? 'unknown'
    const systemDigest = candidate.systemDigest ?? 'unknown'
    const key = [candidate.route, model, systemDigest].join('|')
    let seat = seats.get(key)
    if (!seat) {
      seat = { route: candidate.route, model, systemDigest, entered: 0, wins: 0, defences: 0 }
      seats.set(key, seat)
    }
    if (candidate.incumbent) {
      seat.defences += candidate.won ? 1 : 0
    } else {
      seat.entered++
      seat.wins += candidate.won ? 1 : 0
    }
  }
}

function addGate(gates: Map<string, GateAccumulator>, line: GraphJudgingGate): void {
  const contract = line.contract ?? 'unknown'
  const key = [line.template, line.stepId, line.gate, contract].join('|')
  let gate = gates.get(key)
  if (!gate) {
    gate = {
      template: line.template,
      stepId: line.stepId,
      gate: line.gate,
      contract,
      count: 0,
      decisions: {},
      jevFailed: 0,
      tokens: { input: 0, output: 0, rounds: 0 },
      ms: { total: 0, rounds: 0 }
    }
    gates.set(key, gate)
  }
  gate.count++
  count(gate.decisions, line.decision)
  gate.jevFailed += line.jev?.status === 'failed' ? 1 : 0
  gate.verify = graphGateVerifyTotals(gate.verify, line)
  addTokens(gate.tokens, line.jev?.usage)
  addMs(gate.ms, line.jev?.durationMs)
}

const byName = (left: { template: string; stepId: string }, right: typeof left) =>
  left.template.localeCompare(right.template) || left.stepId.localeCompare(right.stepId)

function groupRow(group: GroupAccumulator): WorkflowJudgingGroup {
  return {
    template: group.template,
    stepId: group.stepId,
    decision: group.decision,
    judgedBy: group.judgedBy,
    rounds: group.rounds,
    wins: group.wins,
    defences: group.defences,
    jev: {
      alone: group.alone,
      escalated: group.escalated,
      failed: group.failedKnown ? group.failed : 'unknown',
      countedWhileUnsure: group.countedWhileUnsure
    },
    agreement: group.agreement.rounds ? group.agreement : 'unknown',
    jevTokens: knownTokens(group.tokens),
    jevUsd: usdOf(group.tokens),
    modelJudgeCalls: group.modelJudgeCalls,
    jevMs: knownSum(group.ms),
    first: group.first,
    last: group.last
  }
}

function gateRow(gate: GateAccumulator): WorkflowJudgingGateRow {
  return {
    template: gate.template,
    stepId: gate.stepId,
    gate: gate.gate,
    contract: gate.contract,
    count: gate.count,
    decisions: gate.decisions,
    jevFailed: gate.jevFailed,
    ...gate.verify,
    jevTokens: knownTokens(gate.tokens),
    jevUsd: usdOf(gate.tokens),
    jevMs: knownSum(gate.ms)
  }
}

/** Where this computer keeps its runs' records: the execution host reads only its own. */
export const workflowJudgingRoot = () =>
  join(getAppEnvironment().getPath('userData'), 'local-workflow-attempts')

export async function workflowJudgingStats(
  request: WorkflowJudgingStatsRequest,
  root = workflowJudgingRoot()
): Promise<WorkflowJudgingStats> {
  const read = await readJudgingLines(root, request)
  const groups = new Map<string, GroupAccumulator>()
  const seats = new Map<string, SeatAccumulator>()
  const gates = new Map<string, GateAccumulator>()
  for (const line of read.lines) {
    if (isGateLine(line)) {
      addGate(gates, line)
    } else {
      addRound(groups, line)
      addSeats(seats, line)
    }
  }
  return {
    note: WORKFLOW_JUDGING_STATS_NOTE,
    source: {
      file: read.file,
      lines: read.read,
      skipped: read.skipped,
      duplicates: read.duplicates,
      matched: read.matched,
      joined: read.joined
    },
    tariff: {
      model: tariff.model,
      inputUsdPerMillion: tariff.inputUsdPerMillion,
      outputUsdPerMillion: tariff.outputUsdPerMillion
    },
    groups: [...groups.values()]
      .sort(
        (left, right) =>
          byName(left, right) ||
          right.rounds - left.rounds ||
          decisionKey(left.decision).localeCompare(decisionKey(right.decision)) ||
          left.judgedBy.localeCompare(right.judgedBy)
      )
      .map(groupRow),
    seats: [...seats.values()].sort(
      (left, right) =>
        right.wins - left.wins ||
        right.entered - left.entered ||
        left.route.localeCompare(right.route) ||
        left.model.localeCompare(right.model)
    ),
    gates: [...gates.values()]
      .sort((left, right) => byName(left, right) || left.gate.localeCompare(right.gate))
      .map(gateRow)
  }
}
