import {
  CompaniesRequestError,
  companiesData,
  needsOmniosSignIn
} from '@/components/companies/companies-client'
import { translate } from '@/i18n/i18n'
import type {
  TeamRoutineRun,
  BoardConversationTurn
} from '../../../../shared/console-routine-conversation-contract'

export function conversationApi() {
  const api = window.api?.consoleRoutineConversation
  if (!api) {
    throw new Error(
      translate(
        'routineConversation.unavailable',
        'Update OmniConsole to open routine conversations.'
      )
    )
  }
  return api
}
export { companiesData }
export function conversationError(error: unknown): string {
  if (needsOmniosSignIn(error)) {
    return translate('teamRoutines.signIn', 'Sign in to see team routines.')
  }
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof CompaniesRequestError) {
    const detail = `${message} (${error.detail.code})`
    if (error.detail.status === 403) {
      return translate('routineConversation.forbidden', 'This action is not allowed: {{message}}', {
        message: detail
      })
    }
    if (error.detail.status === 404) {
      return translate(
        'routineConversation.notFound',
        'This conversation is unavailable: {{message}}',
        { message: detail }
      )
    }
    return detail
  }
  return message
}
export function runKey(run: TeamRoutineRun, index: number): string {
  return run.id ?? run.run_id ?? `${run.created_at ?? ''}:${index}`
}
export function runStatus(run: TeamRoutineRun): string {
  if (run.finished_at == null) {
    return translate('routineConversation.running', 'Running')
  }
  if (run.accepted === false || run.gate_passed === false) {
    return translate('routineConversation.failed', 'Failed')
  }
  if (run.accepted === true || run.gate_passed === true) {
    return translate('routineConversation.succeeded', 'Succeeded')
  }
  return translate('routineConversation.finished', 'Finished')
}
export function turnText(turn: BoardConversationTurn): string {
  return turn.text ?? turn.content ?? ''
}
export function sameTurn(a: BoardConversationTurn, b: BoardConversationTurn): boolean {
  if (a.id && b.id) {
    return a.id === b.id
  }
  return Boolean(a.created_at && a.created_at === b.created_at && turnText(a) === turnText(b))
}
export function orderedRuns(runs: TeamRoutineRun[]): TeamRoutineRun[] {
  return [...runs].sort((a, b) =>
    (b.created_at ?? b.started_at ?? '').localeCompare(a.created_at ?? a.started_at ?? '')
  )
}
