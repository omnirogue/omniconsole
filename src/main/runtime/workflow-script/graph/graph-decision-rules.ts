import {
  contractByRef,
  LEGACY_CONTRACTS
} from '../../../../shared/decision-contracts/decision-contract-library'
import type {
  ConfidencePolicy,
  ContractRef,
  DecisionContract,
  DecisionKind
} from '../../../../shared/decision-contracts/decision-contract-types'
import {
  resolveDecisionContracts,
  workflowDecisionPoints
} from '../../../../shared/decision-contracts/decision-points'
import { WORKFLOW_SCREEN_SET_ASIDE, type WorkflowSpec } from '../../../../shared/workflow-graph'
import { ONE_ANSWER_UNSURE_BAND } from '../../../../shared/workflow-one-answer'
import type { GraphConfig } from './graph-plan-types'

/** Rules 1: every JEV decision reads the contract frozen at admission, and its request names it. */
export const DECISION_RULES = 1

type DecisionConfig = Pick<GraphConfig, 'spec' | 'decisionRules' | 'contracts'>
type Method = ConfidencePolicy['method']

/** What admission freezes: the rules, and each of the spec's decision points' contract today. */
export function graphDecisionAdmission(
  spec: WorkflowSpec
): Required<Pick<GraphConfig, 'decisionRules' | 'contracts'>> {
  return { decisionRules: DECISION_RULES, contracts: resolveDecisionContracts(spec) }
}

/** Absent on older snapshots, which replay under LEGACY_CONTRACTS with no `contract` key. */
export function graphDecisionRules(
  snapshot: object
): Pick<GraphConfig, 'decisionRules' | 'contracts'> {
  const host = (snapshot as { host?: { decisionRules?: unknown; contracts?: unknown } }).host
  if (typeof host?.decisionRules !== 'number') {
    return {}
  }
  const contracts = host.contracts && typeof host.contracts === 'object' ? host.contracts : {}
  return {
    decisionRules: host.decisionRules,
    contracts: contracts as Readonly<Record<string, ContractRef>>
  }
}

/** The contract a decision point runs under: frozen at admission, else the legacy @1 table. */
export function graphContract(config: DecisionConfig, pointKey: string): ContractRef | undefined {
  if (!config.decisionRules) {
    return resolveDecisionContracts(config.spec, LEGACY_CONTRACTS)[pointKey]
  }
  const ref = config.contracts?.[pointKey]
  if (!ref) {
    // A new run never asks JEV without its contract: that would judge by an unrecorded rule.
    throw new Error(`This run has no decision contract for ${pointKey}.`)
  }
  return ref
}

/** Every decision point's contract as this run judges: frozen at admission, else the legacy @1 table. */
export function graphContractTable(config: DecisionConfig): Readonly<Record<string, ContractRef>> {
  return config.decisionRules
    ? (config.contracts ?? {})
    : resolveDecisionContracts(config.spec, LEGACY_CONTRACTS)
}

/** A JEV request's `contract` key: only under decision rules, so older digests never change. */
export function graphContractKey(
  config: DecisionConfig,
  pointKey: string
): { contract?: ContractRef } {
  return config.decisionRules ? { contract: graphContract(config, pointKey)! } : {}
}

/** A contract's confidence policy, refused unless it is one this build runs for that decision. */
export function contractPolicy<M extends Method>(
  ref: ContractRef,
  methods: readonly M[]
): Extract<ConfidencePolicy, { method: M }> {
  const { confidence } = contractByRef(ref)
  if (!(methods as readonly Method[]).includes(confidence.method)) {
    throw new Error(`${ref} judges by ${confidence.method}, which this build does not run here.`)
  }
  return confidence as Extract<ConfidencePolicy, { method: M }>
}

/** The methods this build runs for each kind of decision. */
const RUNS: Record<DecisionKind, readonly Method[]> = {
  'rank-ballot': ['auto', 'pairwise'],
  'criterion-line': ['auto', 'pairwise'],
  'final-check': ['auto', 'pairwise'],
  'screen-order': ['scores'],
  'set-aside-gate': ['score-line'],
  'hard-limit-gate': ['score-line'],
  'one-answer-route': ['noul'],
  'finding-verify': ['noul']
}

/** Whether this build can run a contract where its kind is asked, exactly as it is written. */
function runnable(contract: DecisionContract): boolean {
  const { confidence } = contract
  return (
    RUNS[contract.kind].includes(confidence.method) &&
    !(confidence.method === 'noul' && confidence.bothOrders)
  )
}

/** Plan time: the score below which a screen sets an item aside or drops an option. */
export function graphScoreLine(config: DecisionConfig, pointKey: string): number {
  const ref = graphContract(config, pointKey)
  return ref ? contractPolicy(ref, ['score-line']).below : WORKFLOW_SCREEN_SET_ASIDE
}

/** Plan time: the band inside which JEV's one-answer reading is unsure. */
export function graphRouteBand(config: DecisionConfig): readonly [number, number] {
  const ref = graphContract(config, 'route')
  return ref ? contractPolicy(ref, ['noul']).band : ONE_ANSWER_UNSURE_BAND
}

/** Plan time: whether Find's screen sends options it could not score on to the final (@2). */
export function graphScreenKeepsUnscored(config: DecisionConfig, pointKey: string): boolean {
  const ref = graphContract(config, pointKey)
  return !!ref && contractByRef(ref).unknown.when.includes('unscored')
}

/**
 * A run admitted under decision rules replays only by contracts this build knows and runs: a
 * newer rule, an unknown ref, or a point without its contract is refused, never judged by a guess.
 */
export function assertDecisionReplaySupported(spec: WorkflowSpec, snapshot: object): void {
  const host = (snapshot as { host?: { decisionRules?: unknown; contracts?: unknown } }).host
  if (host?.decisionRules === undefined) {
    return
  }
  const restart = (why: string) => new Error(`${why}; start it again.`)
  if (host.decisionRules !== DECISION_RULES) {
    throw restart("This run's decision rules come from another version of OmniConsole")
  }
  const table = host.contracts
  if (!table || typeof table !== 'object') {
    throw restart('This run has no decision contracts saved')
  }
  const refs = new Map<string, DecisionContract>()
  for (const [key, ref] of Object.entries(table)) {
    try {
      refs.set(key, contractByRef(String(ref)))
    } catch {
      throw restart(`This run judges ${key} by ${String(ref)}, which this build does not know`)
    }
  }
  for (const point of workflowDecisionPoints(spec)) {
    const contract = refs.get(point.key)
    if (!contract || contract.kind !== point.kind || !runnable(contract)) {
      throw restart(`This build can't replay how this run judges ${point.key}`)
    }
  }
}
