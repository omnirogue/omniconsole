import type { SessionChain } from '../../../shared/session-chain-types'

/** File lists come from the execution host's sessionChain.outputFiles, never the local disk. */
export function conversationPlanHistory(
  chain: SessionChain,
  filesByStep: ReadonlyMap<string, readonly string[]> = new Map()
) {
  const stepVersions = new Map(
    chain.steps.map((step) => [
      `step_${step.id}`,
      step.kind === 'handoff' ? 1 : (step.planVersion ?? 1)
    ])
  )
  const versions = new Set([
    1,
    chain.planVersion ?? 1,
    ...(chain.planVersions ?? []).map((entry) => entry.version),
    ...chain.steps.map((step) => (step.kind === 'handoff' ? 1 : (step.planVersion ?? 1)))
  ])
  return [...versions]
    .sort((a, b) => b - a)
    .map((version) => {
      const steps = chain.steps.filter(
        (step) => (step.kind === 'handoff' ? 1 : (step.planVersion ?? 1)) === version
      )
      const ids = new Set(steps.map((step) => step.id))
      const attempts = (chain.outcomeSet?.attempts ?? []).filter(
        (attempt) => (attempt.planVersion ?? stepVersions.get(attempt.actionId) ?? 1) === version
      )
      return {
        version,
        steps,
        attempts,
        verdicts: (chain.verdicts ?? []).filter((verdict) => ids.has(verdict.stepId)),
        files: steps.flatMap((step) => [...(filesByStep.get(step.id) ?? [])]),
        superseded: chain.planVersions?.find((entry) => entry.supersedes === version)
      }
    })
}
