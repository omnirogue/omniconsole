import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../store'
import {
  isCodexResumeRelaunchStatusInFlight,
  useCodexResumeRelaunchStatus
} from './codex-resume-relaunch-state'
import { deriveNativeChatAgentExit } from './native-chat-agent-exit'

/**
 * Store-bound reader for {@link deriveNativeChatAgentExit}.
 *
 * Why the flat selection: `useShallow` compares one level, so a selector that
 * returns a freshly built nested `agentExit` object re-renders on every store
 * tick and React throws #185. Primitives and store-owned references only; the
 * nested shape is rebuilt in a memo.
 */
export function useNativeChatAgentExit(args: {
  terminalTabId: string
  paneKey: string
  targetPtyId: string | null
  hasLiveEntry: boolean
}): ReturnType<typeof deriveNativeChatAgentExit> {
  const relaunchInFlight = isCodexResumeRelaunchStatusInFlight(
    useCodexResumeRelaunchStatus(args.paneKey)
  )
  const { record, exited, worktreeId, hasUndeliveredPrompt } = useAppStore(
    useShallow((state) => {
      const derived = deriveNativeChatAgentExit(state, args)
      return {
        record: derived.record,
        exited: derived.agentExit !== null,
        worktreeId: derived.agentExit?.worktreeId ?? null,
        hasUndeliveredPrompt: derived.agentExit?.hasUndeliveredPrompt ?? false
      }
    })
  )
  return useMemo(
    () => ({
      record,
      agentExit:
        exited && !relaunchInFlight
          ? { resumeRecord: record, worktreeId, hasUndeliveredPrompt }
          : null
    }),
    [record, exited, worktreeId, hasUndeliveredPrompt, relaunchInFlight]
  )
}
