import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import type { SessionPrompt } from './session-prompt'
import { parseSessionPromptScreen } from './session-prompt-screen'
import { readStructuredSessionPrompt } from './session-prompt-structured'
import { readSessionAsyncQuestion, readSessionHookQuestion } from './session-prompt-hook'

export type SessionPromptRuntime = Pick<
  OrcaRuntimeService,
  'readTerminal' | 'resolveTerminalPane' | 'getFreshAgentHookStatusForHandle'
>

export async function readRuntimeSessionPrompt(
  runtime: SessionPromptRuntime,
  row: SessionManageSidebarRow,
  handle: string | null
): Promise<SessionPrompt | null> {
  try {
    if (row.kind === 'structured') {
      if (row.agent !== 'claude' && row.agent !== 'codex') {
        return null
      }
      const host = getStructuredAgentSessionHost()
      return host && row.structuredSessionId
        ? readStructuredSessionPrompt(
            row.structuredSessionId,
            host.pendingPrompts(row.structuredSessionId)
          )
        : null
    }
    if (!handle || !row.paneKey) {
      return null
    }
    const pane = runtime.resolveTerminalPane(row.paneKey, row.worktreeId)
    if (!pane.connected || !pane.ptyId || pane.handle !== handle) {
      return null
    }
    const read = await runtime.readTerminal(handle, { screen: true, limit: 2000 })
    const screen = read.tail.join('\n')
    const hook = runtime.getFreshAgentHookStatusForHandle(handle)
    const parsed =
      read.source === 'screen'
        ? parseSessionPromptScreen(row.agent, screen, hook?.interactivePrompt)
        : null
    return parsed
      ? { ...parsed, delivery: { kind: 'pty', handle, ptyId: pane.ptyId, screen } }
      : (readSessionAsyncQuestion(hook, { handle, ptyId: pane.ptyId }) ??
          readSessionHookQuestion(hook?.interactivePrompt))
  } catch {
    return null
  }
}
