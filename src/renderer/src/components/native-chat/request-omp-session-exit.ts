import { upNextAddressForPane } from '@/lib/conversation-source-for-pane'
import { sessionOutcomeConnection } from '@/lib/session-outcome-connection'
import { parseRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import { makePaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'
import { toHostSessionTabId } from '../../../../shared/terminal-surface-id'
import type { RuntimeTerminalResolvePane } from '../../../../shared/runtime-terminal-contracts'
import { cancelNativeChatPtySends, waitForNativeChatPtyIdle } from './native-chat-pty-send-queue'

/** Captures one host/pane/native session; an acknowledgement only means exit was requested. */
export async function requestOmpSessionExit(args: {
  tabId: string
  paneKey: string
  ptyId: string
  sessionId: string
  runtimeEnvironmentId: string | null
  assertCurrent: () => void
}): Promise<void> {
  args.assertCurrent()
  const address = upNextAddressForPane(args.paneKey, args.tabId)
  const pane = parsePaneKey(args.paneKey)
  if (
    !pane ||
    pane.tabId !== args.tabId ||
    !address ||
    address.source.kind !== 'pty' ||
    address.source.paneKey !== args.paneKey ||
    (address.owner.kind === 'environment' ? address.owner.environmentId : null) !==
      args.runtimeEnvironmentId
  ) {
    throw new Error(
      'The session execution owner is unavailable. Reconnect its host before ending it.'
    )
  }
  const hostTabId =
    address.owner.kind === 'environment' ? toHostSessionTabId(pane.tabId) : pane.tabId
  const hostPaneKey = makePaneKey(hostTabId, pane.leafId)
  const addressKey = JSON.stringify(address)
  const connection = sessionOutcomeConnection(address.owner)
  const assertCurrent = () => {
    args.assertCurrent()
    connection.assertCurrent()
    if (JSON.stringify(upNextAddressForPane(args.paneKey, args.tabId)) !== addressKey) {
      throw new Error('The conversation owner changed. Select it again before ending the session.')
    }
  }
  const host = await connection.negotiate()
  assertCurrent()
  if (host.capabilities.ompSessionExit !== 1 || !host.capabilities.executionRuntimeId) {
    throw new Error(
      'Update the execution host to end OMP sessions here. The Terminal exit command remains available.'
    )
  }
  const { terminal } = await host.call<{ terminal: RuntimeTerminalResolvePane }>(
    'terminal.resolvePane',
    {
      paneKey: hostPaneKey,
      worktreeId: address.source.worktreeId
    }
  )
  assertCurrent()
  const remote = parseRemoteRuntimePtyId(args.ptyId)
  if (
    !terminal?.ptyId ||
    terminal.tabId !== hostTabId ||
    terminal.leafId !== pane.leafId ||
    terminal.worktreeId !== address.source.worktreeId ||
    terminal.connected === false ||
    (address.owner.kind === 'environment'
      ? !remote ||
        remote.environmentId !== address.owner.environmentId ||
        remote.handle !== terminal.handle
      : remote !== null || terminal.ptyId !== args.ptyId)
  ) {
    throw new Error('The selected terminal changed. Inspect its conversation before ending it.')
  }
  cancelNativeChatPtySends(args.ptyId)
  await waitForNativeChatPtyIdle(args.ptyId)
  assertCurrent()
  const receipt = await host.call<{ requested: boolean }>('terminal.endOmpSession', {
    paneKey: hostPaneKey,
    worktreeId: address.source.worktreeId,
    expectedPtyId: terminal.ptyId,
    expectedProviderSessionId: args.sessionId,
    expectedExecutionRuntimeId: host.capabilities.executionRuntimeId
  })
  assertCurrent()
  if (receipt?.requested !== true) {
    throw new Error('End session delivery is unconfirmed. Inspect Terminal before continuing.')
  }
}
