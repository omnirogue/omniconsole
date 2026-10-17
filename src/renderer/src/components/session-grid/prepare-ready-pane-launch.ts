import { useAppStore } from '@/store'
import { selectConsoleAccountScope } from '@/lib/console-account-scope'
import { resolveTerminalCreationRoute } from '@/store/terminals/terminal-workspace-routing'
import { resolveBuildReviewDiscoveryContext } from '../build-review/use-build-review-agent-models'
import { discoverRuntimeCommitMessageModels } from '@/runtime/runtime-git-client'
import { callRuntimeRpc, getRuntimeEnvironmentStatus } from '@/runtime/runtime-rpc-client'
import { fetchProviderAccountsSnapshot } from '@/runtime/runtime-provider-accounts-client'
import { useWorkAgentModelProbes } from '@/hooks/work-agent-model-probes'
import { workAgentModelProbeOwner } from '@/hooks/useWorkAgentCapabilities'
import { refreshWorkProviderUsage } from '@/hooks/useWorkProviderUsage'
import { getCompanyFolderHome } from '@/lib/company-folder-home'
import { resolveCompanyFolder } from '../../../../shared/company-folders'
import {
  classifyLaunchAccountRow,
  launchFableRule,
  LAUNCH_ACCOUNT_FRESH_MS
} from '../../../../shared/account-launch-verdict'
import {
  AGENT_LAUNCH_READINESS_METHOD,
  type AgentLaunchReadinessResult
} from '../../../../shared/agent-launch-account'
import { ensureCompanySessionWorkspace } from '@/lib/company-session-workspace'
import { getResolvedExecutionHostIdForWorktree } from '@/lib/resolved-worktree-execution-host'
import {
  catalogModelsFromDiscovery,
  effortChoicesFor,
  resolveBuildReviewModels
} from '../../../../shared/build-review-model-options'
import {
  resolveLaunchPlan,
  accountCanLaunch
} from '../sidebar/session-folders/new-conversation/resolve-launch-plan'
import type { ReadyDraft, ReadyProvider } from '@/store/ready-pane-drafts'
import { readyPaneOwner, readyAccountCacheKey, useReadyAccountCache } from './ready-pane-options'

export async function prepareReadyPaneLaunch(input: {
  scope: string
  workspace: string
  provider: ReadyProvider
  draft: ReadyDraft
}) {
  const state = useAppStore.getState()
  const assertScope = () => {
    if (selectConsoleAccountScope(useAppStore.getState()) !== input.scope) {
      throw new Error('The account changed. Nothing launched.')
    }
  }
  assertScope()
  const selected = input.workspace
  const route = selected
    ? resolveTerminalCreationRoute(state, selected)
    : { runtimeEnvironmentId: null, connectionId: null }
  const { owner, settings } = readyPaneOwner(selected)
  if (!owner || !settings) {
    throw new Error('The workspace owner is unresolved. Nothing launched.')
  }
  // SSH account paths must never be borrowed from the desktop's account snapshot.
  if (route.connectionId) {
    throw new Error(
      'This SSH host has no verified launcher account snapshot. Open its workspace to launch with its host account.'
    )
  }
  if (route.runtimeEnvironmentId) {
    await getRuntimeEnvironmentStatus(route.runtimeEnvironmentId, 5_000)
  }
  assertScope()
  const context = selected
    ? resolveBuildReviewDiscoveryContext(selected)
    : { runtime: { settings, worktreeId: null, worktreePath: '' } }
  if (!context) {
    throw new Error('The workspace owner is unresolved. Nothing launched.')
  }
  if (!route.runtimeEnvironmentId) {
    await refreshWorkProviderUsage(JSON.stringify([input.scope, owner]), 'explicit')
  }
  const detected = route.runtimeEnvironmentId
    ? await state.refreshRuntimeDetectedAgents(route.runtimeEnvironmentId)
    : await state.refreshDetectedAgents()
  if (!detected.includes(input.provider)) {
    throw new Error('The selected agent is unavailable on the execution host. Nothing launched.')
  }
  assertScope()
  const home = selected ? undefined : await getCompanyFolderHome()
  if (!selected && !home) {
    throw new Error('The Work folder could not be resolved. Nothing launched.')
  }
  const root = home
    ? resolveCompanyFolder({
        home,
        workRoot: settings.companyWorkRoot,
        overrides: settings.companyFolders,
        company: {}
      })
    : undefined
  const readiness = await callRuntimeRpc<AgentLaunchReadinessResult>(
    route.runtimeEnvironmentId
      ? { kind: 'environment', environmentId: route.runtimeEnvironmentId }
      : { kind: 'local' },
    AGENT_LAUNCH_READINESS_METHOD,
    {
      worktree: selected || `path:${root}`,
      agent: input.provider,
      model: input.draft.model || undefined,
      preview: true
    },
    { timeoutMs: 15_000 }
  )
  assertScope()
  const [snapshot, discovery] = await Promise.all([
    fetchProviderAccountsSnapshot(settings),
    discoverRuntimeCommitMessageModels(context.runtime, input.provider)
  ])
  assertScope()
  if (readyPaneOwner(selected).owner !== owner) {
    throw new Error('The workspace owner changed. Nothing launched.')
  }
  const rows = snapshot.rateLimits?.accountCapacity?.[input.provider] ?? []
  useReadyAccountCache.setState((cache) => ({
    rows: { ...cache.rows, [readyAccountCacheKey(input.scope, owner, input.provider)]: rows }
  }))
  const account =
    input.draft.account && input.draft.account !== '__host-default__'
      ? rows.find((row) => row.choiceId === input.draft.account)
      : rows.find((row) => row.isDefault)
  if (
    snapshot.failedProviders?.includes(input.provider) ||
    !account ||
    ['checking', 'signed-out'].includes(account.state) ||
    !accountCanLaunch(account)
  ) {
    throw new Error(
      'The selected account could not be verified on the execution host. Check its account settings and retry.'
    )
  }
  const receipt = readiness.account?.verified ? readiness.account.receipt : undefined
  const verdict = classifyLaunchAccountRow(account, {
    now: Date.now(),
    freshMs: LAUNCH_ACCOUNT_FRESH_MS,
    fable: launchFableRule(input.provider, input.draft.model),
    fableReadingAt:
      receipt?.choiceId === account.choiceId && receipt.fableVerified ? receipt.readingAt : null
  })
  if (
    verdict.state !== 'fresh' ||
    (account.isSystem && rows.some((row) => !row.isSystem && row.isDefault))
  ) {
    throw new Error(
      `The selected account has no fresh verified capacity (${verdict.state}). Nothing launched.`
    )
  }
  if (!discovery.success || !discovery.models.length) {
    throw new Error('Models could not be verified on this host. Your draft has been kept.')
  }
  const models = resolveBuildReviewModels(
    input.provider,
    catalogModelsFromDiscovery(input.provider, discovery.models)
  )
  const prefix = workAgentModelProbeOwner(
    input.scope,
    JSON.stringify(readyPaneOwner(selected).target),
    settings
  )
  useWorkAgentModelProbes.setState((cache) => ({
    probes: { ...cache.probes, [`${prefix}:${input.provider}`]: { models, checkedAt: Date.now() } }
  }))
  const model = input.draft.model
  if (model && !models.some((row) => row.id === model)) {
    throw new Error(
      'The selected model is unavailable on this host. Choose another model explicitly.'
    )
  }
  if (
    input.draft.effort &&
    (!model ||
      !effortChoicesFor(input.provider, models, model).some(
        (row) => row.value === input.draft.effort
      ))
  ) {
    throw new Error(
      'The selected effort is unavailable for this model. Choose another effort explicitly.'
    )
  }
  const stamped = route.runtimeEnvironmentId
    ? { ...account, runtimeEnvironmentId: route.runtimeEnvironmentId }
    : account
  const plan = resolveLaunchPlan({
    hasTarget: true,
    local: !route.runtimeEnvironmentId,
    accountEnvironmentId: route.runtimeEnvironmentId,
    capabilities: [{ id: input.provider, status: 'usable', models, label: input.provider }],
    rows: {
      claude: input.provider === 'claude' ? [stamped] : [],
      codex: input.provider === 'codex' ? [stamped] : []
    },
    pick: {
      agent: input.provider,
      account: stamped,
      model,
      effort: input.draft.effort,
      team: false
    }
  })
  if (plan.kind !== 'launch') {
    throw new Error('The selected launch preferences could not be verified. Nothing launched.')
  }
  let worktreeId = selected
  if (!worktreeId) {
    const result = await ensureCompanySessionWorkspace({
      company: null,
      domain: null,
      agent: input.provider
    })
    if (!result.ok) {
      throw new Error(
        result.reason === 'failed' ? result.message : `The Work folder is missing: ${result.path}`
      )
    }
    worktreeId = `folder:${result.workspace.id}`
  }
  assertScope()
  resolveTerminalCreationRoute(useAppStore.getState(), worktreeId)
  const hostId = getResolvedExecutionHostIdForWorktree(useAppStore.getState(), worktreeId)
  if (!hostId) {
    throw new Error('The execution host is unresolved. Nothing launched.')
  }
  return {
    worktreeId,
    hostId,
    agent: plan.agent,
    launchEnv: plan.launchEnv,
    launchPreferences: plan.launchPreferences
  }
}
