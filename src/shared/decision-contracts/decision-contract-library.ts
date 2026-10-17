import type { WorkflowTemplateId } from '../workflow-graph'
import {
  contractRefOf,
  type ContractRef,
  type DecisionContract,
  type DecisionKind
} from './decision-contract-types'
import { GATE_CONTRACTS } from './decision-contracts-gates'
import { JUDGING_CONTRACTS } from './decision-contracts-judging'
import { VERIFY_DISCARD_CONTRACTS } from './decision-contracts-verify-discard'

/** Every published contract version; a version stays here for as long as a snapshot may name it. */
export const DECISION_CONTRACTS: readonly DecisionContract[] = [
  ...JUDGING_CONTRACTS,
  ...GATE_CONTRACTS,
  ...VERIFY_DISCARD_CONTRACTS
]

const BY_REF: ReadonlyMap<string, DecisionContract> = new Map(
  DECISION_CONTRACTS.map((contract) => [contractRefOf(contract), contract])
)

/** The contract a ref names; an unknown ref throws so a replay never judges by a guessed rule. */
export function contractByRef(ref: string): DecisionContract {
  const contract = BY_REF.get(ref)
  if (!contract) {
    throw new Error(`Unknown decision contract: ${ref}`)
  }
  return contract
}

export type TemplateContracts = Readonly<
  Record<WorkflowTemplateId, Readonly<Partial<Record<DecisionKind, ContractRef>>>>
>
export type ContractTable = {
  byTemplate: TemplateContracts
  generic: Readonly<Record<DecisionKind, ContractRef>>
}

/** Where a template has no contract of its own for a kind (custom workflows, edited templates), at @1. */
export const GENERIC_CONTRACTS: ContractTable['generic'] = {
  'rank-ballot': 'generic-rank-ballot@1',
  'screen-order': 'generic-screen-order@1',
  'set-aside-gate': 'generic-set-aside-gate@1',
  'hard-limit-gate': 'generic-hard-limit-gate@1',
  'criterion-line': 'generic-criterion-line@1',
  'final-check': 'generic-final-check@1',
  'one-answer-route': 'generic-one-answer-route@1',
  'finding-verify': 'generic-finding-verify@1'
}

const FIND_THE_BEST = {
  'screen-order': 'find-screen@1',
  'rank-ballot': 'find-final@1'
} as const

/** Pinned to @1 forever: a snapshot frozen before decision rules replays under exactly these. */
export const LEGACY_CONTRACTS: ContractTable = {
  byTemplate: {
    council: { 'rank-ballot': 'council-peer-rank@1', 'final-check': 'council-final-check@1' },
    discover: { 'set-aside-gate': 'discover-set-aside@1' },
    'build-review': {},
    'best-of-n': FIND_THE_BEST,
    improve: { 'rank-ballot': 'improve-judge@1' },
    find: FIND_THE_BEST,
    decide: {
      'hard-limit-gate': 'decide-shortlist@1',
      'criterion-line': 'decide-compare-line@1',
      'final-check': 'decide-final-check@1',
      'one-answer-route': 'decide-one-answer@1'
    },
    investigate: {},
    'quick-discover': {},
    custom: {}
  },
  generic: GENERIC_CONTRACTS
}

// find-screen@2 corrects how an unscored option is read and keeps @1's confidence policy.
const FIND_THE_BEST_NOW = {
  'screen-order': 'find-screen@2',
  'rank-ballot': 'find-final@1'
} as const

/** What new runs resolve to: the legacy table, but Find's screen never reads unscored as low. */
export const DEFAULT_CONTRACTS: TemplateContracts = {
  ...LEGACY_CONTRACTS.byTemplate,
  discover: { ...LEGACY_CONTRACTS.byTemplate.discover, 'finding-verify': 'discover-verify@1' },
  'best-of-n': FIND_THE_BEST_NOW,
  find: FIND_THE_BEST_NOW
}

/**
 * Live JEV verify's contract, by template, else the generic one: shadow keeps `finding-verify` @1.
 * @3 (discard-only) since 2026-09-28; a run frozen under @2 keeps it (graph-jev-verify-plan.ts).
 */
export const LIVE_FINDING_VERIFY: Readonly<Partial<Record<WorkflowTemplateId, ContractRef>>> & {
  generic: ContractRef
} = {
  discover: 'discover-verify@3',
  generic: 'generic-finding-verify@3'
}

/** What new runs resolve against. */
export const CURRENT_CONTRACTS: ContractTable = {
  byTemplate: DEFAULT_CONTRACTS,
  generic: { ...GENERIC_CONTRACTS, 'screen-order': 'generic-screen-order@2' }
}
