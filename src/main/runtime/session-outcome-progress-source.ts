import { sessionFinishSourceMismatch } from './session-outcome-finish-source'
import { observeSessionOutcomeSource } from './session-outcome-source'
import type { SessionChain } from '../../shared/session-chain-types'
import type { OrcaRuntimeService } from './omni-runtime'

type Progress = { lifecycle: 'waiting'; phase: 'waiting'; reasons: string[] }

/**
 * Why a completed-looking chain is not finished after all.
 *
 * Two refusals answer here and both must hold. Only a SUCCESSFUL source completion counts, so a
 * source that merely exited is refused; and when the chain carries a finish choice, the receipt
 * must still name the exact turn it was bound to, so a source that advanced afterwards is
 * refused too. Null means the source really is finished.
 *
 * A refusal reads as `waiting`, never as needs-you: a source that has not finished, or that moved
 * on, asks nothing of a person — only an attention request does
 * (`docs/reference/session-run-lifecycle.md`). The reason stays as the diagnostic.
 */
export async function sessionOutcomeProgressSourceRefusal(
  runtime: OrcaRuntimeService,
  chain: SessionChain
): Promise<Progress | null> {
  const source = await observeSessionOutcomeSource(runtime, chain, { successfulOnly: true })
  const mismatch = source.ready
    ? sessionFinishSourceMismatch(chain.outcomeSet!, source.version)
    : undefined
  if (source.ready && !mismatch) {
    return null
  }
  return {
    lifecycle: 'waiting',
    phase: 'waiting',
    reasons: mismatch ? [mismatch] : source.reason ? [source.reason] : []
  }
}
