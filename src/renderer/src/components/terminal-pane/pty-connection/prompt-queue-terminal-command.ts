import { useAppStore } from '@/store'
import { upNextAddressForPane } from '@/lib/conversation-source-for-pane'
import { createPromptQueueTerminalInput } from '@/components/prompt-queue/prompt-queue-terminal-input'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

/**
 * Wires this pane's `/next …` reader to the pane's own doors.
 *
 * `erase` is the ordinary input transport — the only bytes it ever carries are
 * backspaces for characters this pane already sent. `echo` writes into xterm and
 * therefore reaches nothing but this person's screen.
 */
export function installPromptQueueTerminalCommand(session: ConnectPanePtySession): void {
  session.promptQueueTerminalInput = createPromptQueueTerminalInput({
    address: () => upNextAddressForPane(session.cacheKey, session.deps.tabId),
    hasAgentSession: () => Boolean(useAppStore.getState().agentStatusByPaneKey[session.cacheKey]),
    erase: (data) => {
      session.transport.sendInput(data)
    },
    echo: (lines) => {
      session.pane.terminal.write(`\r\n${lines.join('\r\n')}\r\n`)
    }
  })
}
