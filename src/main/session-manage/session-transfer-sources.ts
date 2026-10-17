import { isTuiAgent } from '../../shared/tui-agent-config'
import type { SessionTransferResult } from '../../shared/session-transfer-types'
import {
  assertTransferSession,
  transferIdentity,
  type SessionTransferInput,
  type SessionTransferMode,
  type TransferSession
} from './session-manage-transfer-contract'

/**
 * The sources a transfer may take, checked before anything is asked or changed. Consolidate with
 * `skipBusy` reports and skips ineligible sources; every other refusal stops the whole transfer.
 */
export function eligibleTransferSources(
  input: SessionTransferInput,
  mode: SessionTransferMode,
  skipped: SessionTransferResult['skipped'],
  /** Sources on session hosts, checked at their own hosts; they count toward the totals. */
  hosted = 0
): TransferSession[] {
  const { actor, target } = input
  if (mode === 'handoff' && input.sources.length + hosted !== 1) {
    throw new Error('Handoff requires exactly one source.')
  }
  if (mode === 'consolidate' && input.sources.length + hosted < 2) {
    throw new Error('Consolidate requires at least two sources.')
  }
  const keys = input.sources.map((source) => source.row.viewKey)
  if (new Set(keys).size !== keys.length) {
    throw new Error('Sources must be distinct conversations.')
  }
  if (target !== 'new' && keys.includes(target.row.viewKey)) {
    throw new Error('The target must be a different conversation from every source.')
  }
  const sources: TransferSession[] = []
  for (const source of input.sources) {
    try {
      assertTransferSession(actor, source)
      sources.push(source)
    } catch (error) {
      if (mode !== 'consolidate' || !input.skipBusy) {
        throw error
      }
      skipped.push({
        ...transferIdentity(source),
        reason: String(error instanceof Error ? error.message : error)
      })
    }
  }
  if (sources.length + hosted < (mode === 'handoff' ? 1 : 2)) {
    throw new Error('At least two eligible sources must remain after skipping busy sessions.')
  }
  if (target !== 'new') {
    assertTransferSession(actor, target, true)
  }
  if (target === 'new' && sources[0] && !isTuiAgent(sources[0].entry.agent)) {
    throw new Error(`Cannot launch agent kind ${sources[0].entry.agent}.`)
  }
  return sources
}
