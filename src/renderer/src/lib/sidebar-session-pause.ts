import { hasRuntimeRpcErrorCode, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
import type { AgentSessionHistoryResult } from '../../../shared/agent-session-wire'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { makePaneKey, parsePaneKey } from '../../../shared/stable-pane-id'
import { toHostSessionTabId } from '../../../shared/terminal-surface-id'
import type { RuntimeTerminalResolvePane } from '../../../shared/runtime-terminal-contracts'
import type {
  SessionOwnerPauseParams,
  SessionOwnerPauseResult
} from '../../../shared/session-owner-pause'
import {
  resolveSidebarSource,
  type ConversationFleetContextSource
} from './conversation-fleet-context-source'
import { sessionOutcomeConnection } from './session-outcome-connection'
import type { SidebarSession } from './sidebar-sessions'

/** Direct Pause captures execution identity, never a handoff transcript. */
export async function pauseSidebarSessionOnOwner(
  session: SidebarSession,
  source: ConversationFleetContextSource,
  target: RuntimeClientTarget
): Promise<SessionOwnerPauseResult> {
  const sourceHost = parseExecutionHostId(source.sourceHostId)
  if (
    !sourceHost ||
    (sourceHost.kind === 'runtime' &&
      (target.kind !== 'environment' || target.environmentId !== sourceHost.environmentId))
  ) {
    throw new Error('The selected session has no verified execution owner.')
  }
  const hostId = sourceHost.kind === 'runtime' ? 'local' : sourceHost.id
  const captured = JSON.stringify(source)
  const connection = sessionOutcomeConnection(target)
  const assertCurrent = () => {
    connection.assertCurrent()
    if (JSON.stringify(resolveSidebarSource(session)) !== captured) {
      throw new Error(
        'The selected session changed. No pause was sent. Select it again to inspect it.'
      )
    }
  }
  const owner = await connection.negotiate()
  assertCurrent()
  if (!owner.capabilities.executionRuntimeId) {
    throw new Error('Update the execution host before pausing this session.')
  }
  let pauseTarget: SessionOwnerPauseParams['target']
  if (session.kind === 'terminal') {
    const pane = session.paneKey ? parsePaneKey(session.paneKey) : null
    if (!pane || pane.tabId !== session.tabId || !source.sourceProviderSessionId) {
      throw new Error('The exact session identity is unavailable; no pause was sent.')
    }
    let tabId = pane.tabId
    if (target.kind === 'environment') {
      const { resolveHostSessionTabIdForWebSessionTab } =
        await import('@/runtime/web-session-tabs-sync')
      tabId =
        resolveHostSessionTabIdForWebSessionTab(useAppStore.getState(), {
          environmentId: target.environmentId,
          worktreeId: session.worktreeId,
          tabId: pane.tabId
        }) ?? toHostSessionTabId(pane.tabId)
      assertCurrent()
    }
    const paneKey = makePaneKey(tabId, pane.leafId)
    const { terminal } = await connection.call<{ terminal: RuntimeTerminalResolvePane }>(
      'terminal.resolvePane',
      { paneKey, worktreeId: session.worktreeId }
    )
    assertCurrent()
    if (
      !terminal?.ptyId ||
      !terminal.handle ||
      terminal.connected === false ||
      terminal.tabId !== tabId ||
      terminal.leafId !== pane.leafId ||
      terminal.worktreeId !== session.worktreeId ||
      (terminal.executionHostId ?? 'local') !== hostId ||
      (source.sourceTerminalHandle && source.sourceTerminalHandle !== terminal.handle)
    ) {
      throw new Error(
        'The exact terminal on its execution host could not be verified; no pause was sent.'
      )
    }
    pauseTarget = {
      kind: 'terminal',
      hostId,
      worktreeId: session.worktreeId,
      paneKey,
      tabId,
      providerSessionId: source.sourceProviderSessionId,
      agent: source.sourceAgent,
      terminalHandle: terminal.handle,
      ptyId: terminal.ptyId,
      ...(source.sourceWorkingStartedAt === undefined
        ? {}
        : { workingStartedAt: source.sourceWorkingStartedAt }),
      ...(source.sourcePrompt === undefined ? {} : { prompt: source.sourcePrompt })
    }
  } else {
    if (hostId !== 'local') {
      throw new Error('The structured session has no verified owning runtime; no pause was sent.')
    }
    const history = await connection.call<AgentSessionHistoryResult>('agentSession.history', {
      sessionId: source.sourceSessionId,
      direction: 'tail',
      limit: 200
    })
    assertCurrent()
    if (
      !history.ok ||
      history.page.sessionId !== source.sourceSessionId ||
      typeof history.page.fence !== 'number' ||
      !Number.isSafeInteger(history.page.fence) ||
      history.page.fence < 0 ||
      !history.turnState?.lifecycleKnown ||
      history.turnState.awaitingStart
    ) {
      throw new Error('The current session turn could not be verified; no pause was sent.')
    }
    pauseTarget = {
      kind: 'structured',
      hostId,
      worktreeId: session.worktreeId,
      sessionId: source.sourceSessionId,
      turnId: history.turnState.activeTurnId,
      runtimeFence: history.page.fence
    }
  }
  assertCurrent()
  try {
    return await owner.call<SessionOwnerPauseResult>('sessionOwner.pause', { target: pauseTarget })
  } catch (error) {
    if (hasRuntimeRpcErrorCode(error, 'method_not_found')) {
      throw new Error('Update the execution host before pausing this session.')
    }
    throw error
  }
}
