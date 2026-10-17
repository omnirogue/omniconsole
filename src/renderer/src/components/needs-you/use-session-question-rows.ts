import { useAppStore } from '@/store'
import { normalizeSessionQuestionsSettings } from '../../../../shared/session-questions-settings'
import { pendingSessionAsk } from '../../../../shared/session-questions'

/** Needs you shows questions with one-click answers (Settings, on by default). */
export function useSessionQuestionsInline(): boolean {
  return useAppStore(
    (state) => normalizeSessionQuestionsSettings(state.settings?.sessionQuestions).inlineAnswers
  )
}

/** The pane is waiting on a question Needs you can show. */
export function usePaneHasPendingQuestion(paneKey: string | null | undefined): boolean {
  return useAppStore((state) => {
    const status = paneKey ? state.agentStatusByPaneKey[paneKey] : undefined
    return status ? pendingSessionAsk(status) !== null : false
  })
}
