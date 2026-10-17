import { access } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { CommitMessageModelCapability } from '../../shared/commit-message-agent-spec'
import type { SessionChain } from '../../shared/session-chain-types'
import type { TuiAgent } from '../../shared/tui-agent'
import { withTimeout } from '../../shared/promise-timeout-fallback'
import type { OrcaRuntimeService } from './omni-runtime'
import { discoverAgentSessionAccountCatalog } from './agent-session-account-model-catalog'
import { accountChoices } from './workflow-script/local-workflow-provider-catalog'
import { workflowCatalogModels } from './workflow-script/local-workflow-models'
import { WorkflowScriptSlots } from './workflow-script/workflow-script-slots'
import type { SessionPrepRouterCatalog } from '../session-prep/session-prep-router-types'

export type OutcomeRoutingAccounts = Partial<
  Pick<
    OrcaRuntimeService,
    'getAgentAccountSettings' | 'getSessionOutcomeExecutionScope' | 'getDispatchRoutingMode'
  >
>
export type OutcomeRoutingModels = {
  models: CommitMessageModelCapability[]
  unavailableReason?: string
}
const WAIT_MS = 3_000
const slots = new WorkflowScriptSlots(2)
const pending = new WeakMap<object, Map<string, Promise<SessionPrepRouterCatalog>>>()

/** An automatic choice must fit every eligible account the existing workflow may select. */
export async function discoverSessionOutcomeRoutingModels(
  runtime: OutcomeRoutingAccounts,
  chain: SessionChain,
  agent: TuiAgent,
  models: CommitMessageModelCapability[]
): Promise<OutcomeRoutingModels> {
  const unavailable = (unavailableReason: string): OutcomeRoutingModels => ({
    models: [],
    unavailableReason
  })
  if (
    (agent !== 'codex' && agent !== 'claude') ||
    !runtime.getAgentAccountSettings ||
    !runtime.getSessionOutcomeExecutionScope
  ) {
    return unavailable(
      'Workflow account-specific model evidence is unavailable; existing defaults retained'
    )
  }
  const accountsRuntime = { getAgentAccountSettings: runtime.getAgentAccountSettings.bind(runtime) }
  const scopeFor = runtime.getSessionOutcomeExecutionScope.bind(runtime)
  const signal = AbortSignal.timeout(WAIT_MS)
  const read = async (): Promise<OutcomeRoutingModels> => {
    const scope = await scopeFor(chain.worktreeId)
    signal.throwIfAborted()
    if (scope.connectionId || scope.wslDistro || scope.path !== chain.workspacePath) {
      return unavailable(
        'The local workflow execution owner cannot be verified; existing defaults retained'
      )
    }
    const choices = accountChoices(accountsRuntime, agent)
    const identity = JSON.stringify(choices.map(({ id, env }) => [id, env]))
    const eligible = (
      await Promise.all(
        choices.map(async (choice) => {
          const home = agent === 'codex' ? choice.env.CODEX_HOME : choice.env.CLAUDE_CONFIG_DIR
          if (!home || !isAbsolute(home)) {
            return undefined
          }
          try {
            await access(home)
            return choice
          } catch {
            return undefined
          }
        })
      )
    ).filter((choice) => choice !== undefined)
    if (!eligible.length) {
      return unavailable('No eligible workflow account can be verified; existing defaults retained')
    }
    let requests = pending.get(runtime)
    if (!requests) {
      requests = new Map()
      pending.set(runtime, requests)
    }
    const hostId = chain.hostId ?? 'local'
    const listings = await Promise.all(
      eligible.map((choice) => {
        const key = JSON.stringify([hostId, scope.path, agent, choice.env])
        let result = requests.get(key)
        if (!result) {
          result = slots
            .run(
              () =>
                discoverAgentSessionAccountCatalog(
                  {
                    title: 'workflow-model-availability',
                    brief: '',
                    provider: agent,
                    executionTarget: { path: scope.path, hostId }
                  },
                  choice.env,
                  undefined,
                  signal
                ),
              signal
            )
            .finally(() => requests.delete(key))
          requests.set(key, result)
        }
        return result
      })
    )
    const unchanged =
      identity ===
      JSON.stringify(accountChoices(accountsRuntime, agent).map(({ id, env }) => [id, env]))
    if (
      !unchanged ||
      signal.aborted ||
      listings.some(
        (listing) =>
          listing.hostId !== hostId ||
          !listing.agents.some(
            (entry) => entry.provider === agent && entry.discovered && !entry.error
          )
      )
    ) {
      return unavailable(
        'Workflow account model discovery is incomplete or changed; existing defaults retained'
      )
    }
    const accountModels = listings.map(
      (listing) => listing.agents.find((entry) => entry.provider === agent)!.models
    )
    const workflow = workflowCatalogModels(agent)
    const verified = models.flatMap((model) => {
      const seat = workflow.find(
        (entry) => entry.catalog.id === model.id || entry.resolvedModelId === model.id
      )
      const advertised = accountModels.map((listing) =>
        listing.find((entry) => entry.id === model.id)
      )
      if (!seat || advertised.some((entry) => !entry)) {
        return []
      }
      const option = seat.catalog.options.find((entry) => entry.id === 'effort')
      const allowed =
        option?.kind.type === 'select' ? option.kind.choices.map((entry) => entry.value) : []
      const thinkingLevels = (model.thinkingLevels ?? []).filter(
        (level) =>
          allowed.includes(level.id) &&
          advertised.every((entry) => entry?.thinkingLevels?.some((item) => item.id === level.id))
      )
      const defaultEffort = option?.kind.type === 'select' ? option.kind.defaultValue : undefined
      // An omitted effort uses the workflow seat default, not the host CLI's default.
      if (defaultEffort && !thinkingLevels.some((level) => level.id === defaultEffort)) {
        return []
      }
      return [{ ...model, thinkingLevels, defaultThinkingLevel: defaultEffort }]
    })
    return verified.length
      ? { models: verified }
      : unavailable(
          'No model is verified across workflow adapters and eligible accounts; existing defaults retained'
        )
  }
  return withTimeout(
    read().catch(() =>
      unavailable('Workflow account model discovery is unavailable; existing defaults retained')
    ),
    WAIT_MS,
    unavailable('Workflow account model discovery is pending; existing defaults retained')
  )
}
