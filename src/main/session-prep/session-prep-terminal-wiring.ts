import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { readProjectForPane } from '../session-projects/project-for-pane'
import { createTerminalPromptInterceptor } from './session-prep-terminal-intercept'
import { readClaudeTranscriptContext } from './session-prep-transcript-context'
import { claimTerminalKeyboardSubmit } from './terminal-keyboard-submits'

/** The agent-hook prompt interceptor for terminal Claude sessions, bound to the live runtime. */
export function createTerminalSessionPrepInterceptor(getRuntime: () => OrcaRuntimeService | null) {
  return createTerminalPromptInterceptor({
    service: () => getRuntime()?.getSessionPrepService() ?? null,
    automaticDispatch: () => getRuntime()?.isAutomaticOutcomeDispatchEnabled() ?? false,
    ptyIdForPaneKey: (paneKey) => getRuntime()?.getPtyIdForPaneKey(paneKey) ?? null,
    worktreeIdForPaneKey: (paneKey) =>
      getRuntime()?.getTerminalWorktreeIdForPaneKey(paneKey) ?? null,
    claimKeyboardSubmit: claimTerminalKeyboardSubmit,
    readContext: readClaudeTranscriptContext,
    projectForPane: async (paneKey) => {
      const runtime = getRuntime()
      return runtime ? readProjectForPane(runtime, paneKey) : null
    }
  })
}
