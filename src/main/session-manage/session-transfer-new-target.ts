import { conversationSourcesEqual, type ConversationSource } from '../../shared/conversation-source'
import { isUntouchedFreshStart } from '../agent-hooks/fresh-session-start'
import { agentHookServer } from '../agent-hooks/server'
import { onConversationWriteInvalidation } from '../runtime/conversation-write-fence'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'

/** Held only for a new, non-resumed launch made by this transfer, from before spawning it. */
export function watchNewTransferTarget(source: ConversationSource) {
  let untouched = true
  let freshStart = false
  let ptyId: string | null = null
  let handle: string | null = null
  const expiresAt = Date.now() + 10 * 60_000
  const unobserve = onConversationWriteInvalidation((changed, reason) => {
    if (reason === 'hook') {
      return
    }
    try {
      if (changed(source)) {
        untouched = false
      }
    } catch {
      untouched = false
    }
  })
  const unhook = agentHookServer.subscribeEnrichedStatus((report) => {
    if (report.paneKey !== source.paneKey) {
      return
    }
    // Only the empty session-start announcement is allowed before this first prompt.
    if (isUntouchedFreshStart(report)) {
      freshStart = true
    } else {
      untouched = false
    }
  })
  return {
    bind(terminal: { handle: string; ptyId?: string }): void {
      handle = terminal.handle
      ptyId = terminal.ptyId ?? null
    },
    neverReplied(
      runtime: Pick<OrcaRuntimeService, 'resolveTerminalPane'>,
      candidate: ConversationSource
    ): boolean {
      if (
        !untouched ||
        !freshStart ||
        Date.now() >= expiresAt ||
        !ptyId ||
        !handle ||
        !conversationSourcesEqual(source, candidate)
      ) {
        return false
      }
      try {
        const live = runtime.resolveTerminalPane(source.paneKey, source.worktreeId)
        return live.handle === handle && live.ptyId === ptyId && live.connected === true
      } catch {
        return false
      }
    },
    close(): void {
      untouched = false
      unobserve()
      unhook()
    }
  }
}
