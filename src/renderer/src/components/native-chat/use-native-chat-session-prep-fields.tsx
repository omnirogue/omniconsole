import { useAppStore } from '@/store'
import type { AgentType } from '../../../../shared/agent-status-types'
import { SessionPrepStatus } from './SessionPrepStatus'
import { useSessionPrepCommand } from './use-session-prep-command'

type SessionPrepComposerSource = {
  paneKey: string
  terminalTabId: string
  agent: AgentType
  getConversationContext?: () => string
}

export function useNativeChatSessionPrepFields(
  source: SessionPrepComposerSource,
  draft: string,
  setDraft: (value: string) => void,
  report: (notice: string) => void
): { prepareSessions: (text: string) => boolean; sessionPrepStatus: React.ReactNode } {
  const automaticDispatch = useAppStore(
    (state) =>
      state.settings?.automaticOutcomeDispatch !== false &&
      state.settings?.dispatchRoutingMode !== 'off'
  )
  const prepareSessions = useSessionPrepCommand({
    automaticDispatch,
    paneKey: source.paneKey,
    tabId: source.terminalTabId,
    agent: source.agent,
    getContext: source.getConversationContext ?? (() => ''),
    setDraft,
    report
  })
  return {
    prepareSessions,
    sessionPrepStatus: (
      <SessionPrepStatus paneKey={source.paneKey} draft={draft} setDraft={setDraft} />
    )
  }
}
