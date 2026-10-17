import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { createAgentSessionCreateOperation } from '@/runtime/agent-session-create-operation'
import { createWebRuntimeSessionTerminalResult } from '@/runtime/web-runtime-terminal-create-operation'
import { resolveWebTerminalSurfaceTabIdForHost } from '@/runtime/web-session-mirror-owner'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { resolveWorktreeOperationRoute } from './worktree-operation-route'
import { captureWorktreeOperationGenerationGuard } from './worktree-operation-generation'
import { activateAndRevealWorkspace } from './worktree-activation'
import { activateTabAndFocusPane } from './activate-tab-and-focus-pane'
import type { RuntimeCreateAgentSessionResult } from '../../../shared/agent-session-host-authority'
import { openrouterApiId } from '../../../shared/openrouter-route'

/** Use the host's exact-route preparation, including its auth and no-fallback config. */
export async function launchCustomModel(input: {
  worktreeId: string
  modelId: string
  viewMode: 'chat' | 'terminal'
  prompt?: string
  onSessionCreated?: (tabId: string) => void
}): Promise<string | undefined> {
  const modelId = openrouterApiId.parse(input.modelId)
  const route = resolveWorktreeOperationRoute(useAppStore.getState(), input.worktreeId)
  const changed = () =>
    new Error(
      translate(
        'customModels.hostChanged',
        'The execution host changed or is unavailable. Reopen the launcher and try again.'
      )
    )
  if (!route) {
    throw changed()
  }
  const guard = captureWorktreeOperationGenerationGuard(
    useAppStore.getState,
    input.worktreeId,
    route,
    changed
  )
  const launchPreferences = { model: `openrouter/${modelId}` }
  if (route.runtimeEnvironmentId) {
    const result = await createWebRuntimeSessionTerminalResult({
      worktreeId: input.worktreeId,
      environmentId: route.runtimeEnvironmentId,
      agent: 'omp',
      agentSessionKind: 'fresh',
      launchPreferences,
      viewMode: input.viewMode,
      activate: true,
      ...(input.prompt ? { prompt: input.prompt, promptDelivery: 'auto-submit' as const } : {})
    })
    if (result.outcome.status === 'failed') {
      throw new Error(result.outcome.message)
    }
    const tabId = result.hostTabId
      ? resolveWebTerminalSurfaceTabIdForHost(
          useAppStore.getState(),
          route.runtimeEnvironmentId,
          input.worktreeId,
          result.hostTabId
        )
      : undefined
    if (tabId) {
      input.onSessionCreated?.(tabId)
    }
    return tabId
  }
  const operation = createAgentSessionCreateOperation()
  const result = await operation.run((clientOperationId) => {
    guard.assertCurrent()
    return callRuntimeRpc<RuntimeCreateAgentSessionResult>(
      { kind: 'local' },
      'terminal.createAgentSession',
      {
        clientOperationId,
        worktree: toRuntimeWorktreeSelector(input.worktreeId),
        agent: 'omp',
        launchPreferences,
        viewMode: input.viewMode,
        presentation: 'focused',
        ...(input.prompt ? { prompt: input.prompt, promptDelivery: 'auto-submit' } : {})
      }
    )
  })
  if (result.terminal.tabId) {
    input.onSessionCreated?.(result.terminal.tabId)
  }
  activateAndRevealWorkspace(input.worktreeId, { providesInitialSurface: true })
  if (result.terminal.tabId) {
    activateTabAndFocusPane(result.terminal.tabId, null)
  }
  return result.terminal.tabId
}
