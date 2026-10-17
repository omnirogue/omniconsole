import { checkAgentLaunchPreferences } from '../../../shared/agent-launch-preference-check'
import type { LocalWorkflowSeatCatalog } from '../../../shared/local-workflow-seats'
import { resolveLocalWorkflowSeat } from '../../../shared/local-workflow-seats'
import type { LocalWorkflowView } from '../../../shared/local-workflow-view'

/** Keep a follow-up on the exact synthesis route the host used, or refuse the launch. */
export function planLocalWorkflowFollowUpLaunch(input: {
  view: LocalWorkflowView
  catalog: readonly LocalWorkflowSeatCatalog[]
}) {
  const seat = input.view.followUpSeat
  if (input.view.state !== 'completed' || !input.view.result || !seat) {
    throw new Error('The completed workflow synthesis route is unavailable.')
  }
  if (seat.agent === 'openrouter' || seat.agent === 'ollama') {
    const name = seat.agent === 'ollama' ? 'Ollama' : 'OpenRouter'
    throw new Error(`${name} workflow follow-ups are unavailable.`)
  }
  const routes = input.catalog.filter(
    (entry) => entry.agent === seat.agent && entry.accountId === seat.accountId
  )
  // A run admitted by an earlier app version carries that version's revision of the same route.
  const route = routes.length === 1 ? routes[0] : undefined
  const accepted = route ? [route.policyRevision, ...(route.priorPolicyRevisions ?? [])] : []
  if (!accepted.includes(seat.policyRevision)) {
    throw new Error('The workflow model or account has changed. Refresh the workflow setup.')
  }
  const models = routes[0].models.filter(
    (entry) => entry.resolvedModelId === seat.model && entry.lineage === seat.lineage
  )
  if (models.length !== 1) {
    throw new Error('The workflow synthesis model is no longer available.')
  }
  const model = models[0].catalog.id
  const current = resolveLocalWorkflowSeat(
    {
      id: seat.id,
      agent: seat.agent,
      accountId: seat.accountId,
      model,
      ...(seat.effort ? { effort: seat.effort } : {})
    },
    input.catalog
  )
  if (
    current.id !== seat.id ||
    current.agent !== seat.agent ||
    current.accountId !== seat.accountId ||
    current.model !== seat.model ||
    current.effort !== seat.effort ||
    current.lineage !== seat.lineage
  ) {
    throw new Error('The workflow synthesis route has changed. Refresh before following up.')
  }
  const accountHome = routes[0].accountHome
  if (!accountHome?.trim()) {
    throw new Error('The host-verified workflow account home is unavailable.')
  }
  const launchEnv = {
    [seat.agent === 'claude'
      ? 'CLAUDE_CONFIG_DIR'
      : seat.agent === 'codex'
        ? 'CODEX_HOME'
        : 'GROK_HOME']: accountHome
  }
  const checked = checkAgentLaunchPreferences(seat.agent, {
    model,
    ...(seat.effort ? { effort: seat.effort } : {})
  })
  if (!checked.ok || !checked.preferences) {
    throw new Error(
      checked.ok ? 'The workflow synthesis model cannot be launched.' : checked.message
    )
  }
  return { agent: seat.agent, launchEnv, launchPreferences: checked.preferences }
}
