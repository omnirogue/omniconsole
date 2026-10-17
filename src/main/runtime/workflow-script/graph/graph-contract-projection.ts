import { graphContractTable } from './graph-decision-rules'
import { DECISION_CONTRACTS } from '../../../../shared/decision-contracts/decision-contract-library'
import { contractRefOf } from '../../../../shared/decision-contracts/decision-contract-types'
import { decisionContractCheck } from '../../../../shared/decision-contracts/decision-contract-check'

const KNOWN_CONTRACTS = new Set(DECISION_CONTRACTS.map(contractRefOf))

/** How far each decision point's rule has been checked; a ref this build does not know is left out. */
export function projectContracts(config: Parameters<typeof graphContractTable>[0]) {
  return Object.entries(graphContractTable(config))
    .filter(([, ref]) => KNOWN_CONTRACTS.has(ref))
    .map(([point, ref]) => decisionContractCheck(point, ref))
}
