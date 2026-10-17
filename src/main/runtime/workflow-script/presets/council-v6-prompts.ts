import type { CouncilStanding } from './council-ranking'

export type CouncilAccess = 'workspace-read' | 'frozen'

/** Only context added to the user's question when members may read the workspace. */
export const COUNCIL_WORKSPACE_CONTEXT =
  "You are one member of a council answering the question below. You are running inside the user's workspace at the current directory and may read files (read-only) to ground your answer. Cite files as path:line when you rely on them."

export const COUNCIL_CHAIR_WORKSPACE_NOTE =
  'You may read files in the workspace to check disputed claims.'

/** The chairman writes for the reader, who never saw the anonymous labels. */
export const COUNCIL_CHAIR_NAMES_NOTE =
  'Refer to council members by model name, never by response letter; the table above maps any letter a ranking still uses to its model.'

export const COUNCIL_RANKING_PROBLEM =
  'Your evaluation must end with a FINAL RANKING: list naming the responses.'

/** Stage 1: the user's question as Karpathy sends it, plus attached files as plain text. */
export function councilAnswerPrompt(
  task: { prompt: string; evidence: string },
  access: CouncilAccess
): string {
  const question =
    access === 'workspace-read'
      ? `${COUNCIL_WORKSPACE_CONTEXT}\n\nQuestion: ${task.prompt}`
      : task.prompt
  return task.evidence.trim() ? `${question}\n\nAttached files:\n${task.evidence}` : question
}

/** Stage 2: karpathy/llm-council `stage2_collect_rankings` prompt, byte for byte. */
export function councilRankingPrompt(
  question: string,
  responses: readonly { label: string; markdown: string }[]
): string {
  const responsesText = responses
    .map((response) => `${response.label}:\n${response.markdown}`)
    .join('\n\n')
  return `You are evaluating different responses to the following question:

Question: ${question}

Here are the responses from different models (anonymized):

${responsesText}

Your task:
1. First, evaluate each response individually. For each response, explain what it does well and what it does poorly.
2. Then, at the very end of your response, provide a final ranking.

IMPORTANT: Your final ranking MUST be formatted EXACTLY as follows:
- Start with the line "FINAL RANKING:" (all caps, with colon)
- Then list the responses from best to worst as a numbered list
- Each line should be: number, period, space, then ONLY the response label (e.g., "1. Response A")
- Do not add any other text or explanations in the ranking section

Example of the correct format for your ENTIRE response:

Response A provides good detail on X but misses Y...
Response B is accurate but lacks depth on Z...
Response C offers the most comprehensive answer...

FINAL RANKING:
1. Response C
2. Response A
3. Response B

Now provide your evaluation and ranking:`
}

export type CouncilChairInput = {
  question: string
  answers: readonly { name: string; markdown: string }[]
  ballots: readonly { name: string; evaluation: string }[]
  standings: readonly (CouncilStanding & { name: string })[]
  access: CouncilAccess
}

/**
 * Street cred table. Rankings reach the chairman under model names; the Response column maps a
 * bare letter a reviewer wrote ("B and C agree") to its model.
 */
export function councilStreetCredTable(standings: CouncilChairInput['standings']): string {
  const rows = standings.map((standing) =>
    standing.votes
      ? `| ${standing.place} | ${standing.name} | ${standing.label} | ${standing.averageRank.toFixed(2)} | ${standing.votes} |`
      : `| - | ${standing.name} | ${standing.label} | not ranked | 0 |`
  )
  return [
    'Street cred (average rank, lower is better; self-votes excluded):',
    '| Place | Model | Response | Average rank | Votes |',
    '| --- | --- | --- | --- | --- |',
    ...rows
  ].join('\n')
}

/**
 * Stage 3: karpathy/llm-council `stage3_synthesize_final` prompt, byte for byte, with the
 * de-anonymised stages (the caller names the members in the rankings' text). The street cred
 * table, the model-name note and the workspace note are the only additions and sit between
 * Karpathy's sections so his text stays intact.
 */
export function councilChairPrompt(input: CouncilChairInput): string {
  const stage1 = input.answers
    .map((answer) => `Model: ${answer.name}\nResponse: ${answer.markdown}`)
    .join('\n\n')
  const stage2 = input.ballots
    .map((ballot) => `Model: ${ballot.name}\nRanking: ${ballot.evaluation}`)
    .join('\n\n')
  const additions = [
    councilStreetCredTable(input.standings),
    COUNCIL_CHAIR_NAMES_NOTE,
    ...(input.access === 'workspace-read' ? [COUNCIL_CHAIR_WORKSPACE_NOTE] : [])
  ].join('\n\n')
  return `You are the Chairman of an LLM Council. Multiple AI models have provided responses to a user's question, and then ranked each other's responses.

Original Question: ${input.question}

STAGE 1 - Individual Responses:
${stage1}

STAGE 2 - Peer Rankings:
${stage2}

${additions}

Your task as Chairman is to synthesize all of this information into a single, comprehensive, accurate answer to the user's original question. Consider:
- The individual responses and their insights
- The peer rankings and what they reveal about response quality
- Any patterns of agreement or disagreement

Provide a clear, well-reasoned final answer that represents the council's collective wisdom:`
}
