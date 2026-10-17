/**
 * Who this host can really put in a stage — the catalogue the lowering validates against.
 *
 * Every seat a plan commits is checked against `WorkPlanContext.usableAgents`: an agent that
 * is not in it is refused (`actor-not-usable`), and a shape that needs a judge from another
 * family is refused unless two families are in it (`shapeAvailable`). So the catalogue is not
 * a formality — it decides whether Council, Best-of-N and an explicitly chosen model can be
 * committed at all.
 *
 * Nothing here invents a capability. The synchronous catalogue is made of facts the engine
 * already holds: the conversation's own agent, every actor the chain has already launched, and
 * the exact model/effort the person picked in the composer. A shape that needs a SECOND model
 * family needs more than that, and the only honest source is the host's own probe — the same
 * one the Start Work picker and `omni outcome context` trust (`nextOutcomeTeamUsableModels`,
 * which keeps only models this build can launch exactly, never a static catalogue guess).
 */

import { mayIssueVerdict } from '../../shared/model-lineage'
import {
  nextOutcomeTeamUsableModels,
  type NextOutcomeTeamUsableAgent,
  type NextOutcomeTeamUsableModel
} from '../../shared/next-outcome-team-plan-schema'
import type { SessionChain } from '../../shared/session-chain-types'
import type { TuiAgent } from '../../shared/tui-agent'
import type { WorkPlanActor } from '../../shared/work-plan-types'
import type { OrcaRuntimeService } from './omni-runtime'

/**
 * The agents a Council or Best-of-N may draw an independent judge from: the ones this build
 * can place in a model family at all and that are allowed to decide (Gemini may work but may
 * not judge — Sal, 2026-08-09). A seat whose family cannot be named can never be shown to be
 * independent of what it judges, so it is not a candidate.
 */
const JUDGE_CANDIDATES: readonly TuiAgent[] = (
  ['claude', 'codex', 'grok', 'kimi', 'qwen-code'] as const satisfies readonly TuiAgent[]
).filter((agent) => mayIssueVerdict(agent))

function mergeModels(
  into: NextOutcomeTeamUsableModel[],
  model: string | undefined,
  effort: string | undefined
): NextOutcomeTeamUsableModel[] {
  if (!model) {
    return into
  }
  const known = into.find((entry) => entry.id === model)
  if (!known) {
    return [...into, { id: model, label: model, efforts: effort ? [effort] : [] }]
  }
  return into.map((entry) =>
    entry.id === model && effort && !entry.efforts.includes(effort)
      ? { ...entry, efforts: [...entry.efforts, effort] }
      : entry
  )
}

/** One catalogue out of several, merged per agent so a model is never listed twice. */
export function mergeUsableAgents(
  catalogues: readonly (readonly NextOutcomeTeamUsableAgent[])[]
): NextOutcomeTeamUsableAgent[] {
  const merged: NextOutcomeTeamUsableAgent[] = []
  for (const entry of catalogues.flat()) {
    const known = merged.find((candidate) => candidate.agent === entry.agent)
    if (!known) {
      merged.push({ agent: entry.agent, models: [...entry.models] })
      continue
    }
    for (const model of entry.models) {
      known.models = model.efforts.length
        ? model.efforts.reduce((into, effort) => mergeModels(into, model.id, effort), known.models)
        : mergeModels(known.models, model.id, undefined)
    }
  }
  return merged
}

/**
 * The actors the chain has already launched under. They are usable by demonstration: this
 * host started them, so re-reading its own plan (to remove or reorder a stage) can never be
 * refused because the catalogue forgot a seat it is already running.
 */
export function launchedUsableAgents(chain: SessionChain | null): NextOutcomeTeamUsableAgent[] {
  const catalogue: NextOutcomeTeamUsableAgent[] = []
  for (const step of chain?.steps ?? []) {
    if (step.kind === 'handoff') {
      continue
    }
    const known = catalogue.find((entry) => entry.agent === step.agent)
    if (!known) {
      catalogue.push({
        agent: step.agent,
        models: mergeModels([], step.model, step.effort)
      })
      continue
    }
    known.models = mergeModels(known.models, step.model, step.effort)
  }
  return catalogue
}

/**
 * What the host can launch, asked of the host. One probe per candidate agent, in parallel,
 * keeping only the agents whose model catalogue was really discovered — a probe that failed
 * is an agent this host cannot launch, and it is left out rather than assumed.
 */
export async function probeUsableAgents(
  runtime: Pick<OrcaRuntimeService, 'discoverRuntimeCommitMessageModels'>,
  worktreeSelector: string
): Promise<NextOutcomeTeamUsableAgent[]> {
  if (typeof runtime.discoverRuntimeCommitMessageModels !== 'function') {
    return []
  }
  const probed = await Promise.all(
    JUDGE_CANDIDATES.map(async (agent) => ({
      agent,
      models: nextOutcomeTeamUsableModels(
        agent,
        await runtime.discoverRuntimeCommitMessageModels(worktreeSelector, agent).catch(() => null)
      )
    }))
  )
  return probed.filter((entry) => entry.models.length > 0)
}

/** Every actor a catalogue offers, one per model, so a fragment can seat more than one family. */
export function usableAgentActors(
  catalogue: readonly NextOutcomeTeamUsableAgent[]
): WorkPlanActor[] {
  return catalogue.flatMap<WorkPlanActor>(({ agent, models }) =>
    models.length
      ? models.map((model) => ({
          agent,
          model: model.id,
          ...(model.efforts[0] ? { effort: model.efforts[0] } : {})
        }))
      : [{ agent }]
  )
}
