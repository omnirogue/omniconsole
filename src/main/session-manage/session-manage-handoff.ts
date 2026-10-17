import type { SessionTransferDeps, SessionTransferInput } from './session-manage-transfer-contract'
import { transferSessions } from './session-manage-transfer'

export function handoffSession(deps: SessionTransferDeps, input: SessionTransferInput) {
  return transferSessions(deps, input, 'handoff')
}
