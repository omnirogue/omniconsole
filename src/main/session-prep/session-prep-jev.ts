import type { PrepJevAsk } from '../../shared/session-prep-types'
import { JEV_MODEL } from '../../shared/jev-confidence'
import { jevDecide } from '../structured-decisions/jev-rank'

/** Nouls through the shared 8 s JEV path; any refusal or missing answer throws to the fallback. */
export const sessionPrepJevAsk: PrepJevAsk = async (state, questions) => {
  const result = await jevDecide(
    {
      capability: 'session-prep.gate',
      model: JEV_MODEL,
      state,
      questions: Object.fromEntries(
        Object.entries(questions).map(([id, text]) => [
          id,
          { type: 'noul' as const, instructions: text }
        ])
      )
    },
    { caller: 'session-prep.gate' }
  )
  if ('failed' in result) {
    throw new Error(result.failed)
  }
  const scores: Record<string, number> = {}
  for (const id of Object.keys(questions)) {
    const answer = result.answers[id]
    if (!answer || answer.type !== 'noul') {
      throw new Error(`JEV did not answer ${id}`)
    }
    scores[id] = answer.noul
  }
  return scores
}
