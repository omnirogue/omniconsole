import { jevRank } from '../../../../src/main/structured-decisions/jev-rank'

/**
 * Skeleton scorer for the Council/Decide set: JEV scores the run's final answer and the
 * reference answer on the set's rubric (`jevRank`, rubric method), so a run is measured by how
 * close it comes to the reference. The references are unreviewed (see decide/questions.json):
 * treat the numbers as a trend line, not a verdict, until a panel has checked them.
 */

export type DecideQuestion = {
  id: string
  kind: 'one-answer' | 'judgment'
  question: string
  reference: string
  pair: { a: string; b: string; better: 'a' | 'b' }
}

export type DecideSet = {
  set: string
  version: number
  rubric: string
  questions: DecideQuestion[]
}

export type DecideScore =
  | {
      id: string
      /** JEV's 0–4 rubric score for the run's answer and for the reference. */
      run: number
      reference: number
      /** run − reference: 0 or more means the run matched the reference on the rubric. */
      gap: number
      unsure: boolean
      calls: number
    }
  | { id: string; failed: string }

export async function scoreDecideAnswer(
  set: Pick<DecideSet, 'rubric'>,
  question: DecideQuestion,
  answer: string,
  rank: typeof jevRank = jevRank
): Promise<DecideScore> {
  if (!answer.trim()) {
    return { id: question.id, failed: 'the run gave no final answer' }
  }
  const ranking = await rank({
    method: 'rubric',
    task: question.question,
    rubric: set.rubric,
    candidates: [
      { id: 'run', text: answer },
      { id: 'reference', text: question.reference }
    ]
  })
  if ('failed' in ranking) {
    return { id: question.id, failed: ranking.failed }
  }
  const run = ranking.scores.run ?? 0
  const reference = ranking.scores.reference ?? 0
  return {
    id: question.id,
    run,
    reference,
    gap: run - reference,
    unsure: ranking.unsure,
    calls: ranking.calls
  }
}
