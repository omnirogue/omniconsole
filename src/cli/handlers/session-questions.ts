import {
  SESSION_QUESTIONS_RPC,
  type PendingSessionQuestion,
  type SessionQuestionsResult
} from '../../shared/session-questions'
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { refuseRemote } from './session-manage-access'

function formatQuestion(entry: PendingSessionQuestion): string {
  const head = `${entry.title ?? entry.paneKey} (${entry.paneKey})`
  const lines = entry.questions.map((question) => {
    const options = question.options.map((option, index) => `${index + 1}. ${option.label}`)
    const kind = question.multiSelect ? ' [choose several]' : ''
    return `  ${question.question}${kind}\n    ${options.join('   ')}`
  })
  return [head, ...lines].join('\n')
}

export function formatSessionQuestions(result: SessionQuestionsResult): string {
  return result.questions.length === 0
    ? 'No session is waiting on a question.'
    : result.questions.map(formatQuestion).join('\n\n')
}

export const SESSION_QUESTIONS_HANDLERS: Record<string, CommandHandler> = {
  'session questions': async ({ client, json }) => {
    refuseRemote(client)
    const response = await client.call<SessionQuestionsResult>(SESSION_QUESTIONS_RPC.list, {})
    printResult(response, json, formatSessionQuestions)
  }
}
