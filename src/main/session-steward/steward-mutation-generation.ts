import { conversationSourceRowKey } from '../../shared/conversation-source'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import {
  conversationMutationGeneration,
  ptyInputGeneration
} from '../runtime/conversation-mutation-generation'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { sessionManageSource } from '../session-manage/session-manage-observe'

/** Queue writes by the conversation's row key plus keystrokes by its PTY, when it has one. */
export function stewardMutationGeneration(
  runtime: Pick<OrcaRuntimeService, 'resolveTerminalPane'>,
  row: SessionManageSidebarRow
): number {
  const source = sessionManageSource(row)
  if (!source) {
    return 0
  }
  let generation = conversationMutationGeneration(conversationSourceRowKey(source))
  if (source.kind === 'pty') {
    try {
      const { ptyId } = runtime.resolveTerminalPane(source.paneKey, source.worktreeId)
      generation += ptyId ? ptyInputGeneration(ptyId) : 0
    } catch {
      // Why ignored: a pane without a PTY takes no keystrokes.
    }
  }
  return generation
}
