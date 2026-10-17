import { describe, expect, it } from 'vitest'
import { validateJsonSchema } from '../../../../shared/json-schema-validate'
import type { ResolvedLocalWorkflowSeat } from '../../../../shared/local-workflow-seats'
import type { ModelLineage } from '../../../../shared/model-lineage'
import { createWorkflowProgramContext, type WorkflowProgramCall } from '../workflow-program-context'
import { assertWorkflowSchemaContract } from '../workflow-schema-contract'
import textAnswerSchema from './schemas/text-answer.schema.json'
import {
  COUNCIL_ANSWER_TIMEOUT_MS,
  COUNCIL_CHAIR_TIMEOUT_MS,
  COUNCIL_RANK_TIMEOUT_MS,
  councilLineupProblem,
  runCouncilV6Program,
  type CouncilV6Config
} from './council-v6'
import { councilSeatNames } from './council-ranking'
import {
  COUNCIL_CHAIR_NAMES_NOTE,
  COUNCIL_CHAIR_WORKSPACE_NOTE,
  COUNCIL_RANKING_PROBLEM,
  COUNCIL_WORKSPACE_CONTEXT
} from './council-v6-prompts'

const seat = (
  id: string,
  agent: ResolvedLocalWorkflowSeat['agent'],
  lineage: ModelLineage,
  model: string
): ResolvedLocalWorkflowSeat => ({
  id,
  agent,
  accountId: 'account',
  model,
  effort: null,
  lineage,
  policyRevision: 'test'
})
const seats = [
  seat('seat-1', 'claude', 'anthropic', 'claude-opus-5'),
  seat('seat-2', 'codex', 'openai', 'gpt-5.6-sol'),
  seat('seat-3', 'grok', 'xai', 'grok-4.6-build'),
  seat('seat-4', 'gemini', 'google', 'gemini-3.8-flash')
]
const config = (overrides: Partial<CouncilV6Config> = {}): CouncilV6Config => ({
  seats,
  memberIds: ['seat-1', 'seat-2', 'seat-3', 'seat-4'],
  chairId: 'seat-1',
  access: 'frozen',
  ...overrides
})
const task = { prompt: 'Which cache should we use?', evidence: '' }

/** "Response X:" headers in presentation order, as a reviewer sees them. */
const shownLabels = (prompt: string): string[] =>
  [...prompt.matchAll(/^(Response [A-Z]):$/gm)].map((match) => match[1])

function harness(
  options: {
    failAnswers?: string[]
    rankings?: Record<string, string>
    failChair?: boolean
  } = {}
) {
  const calls: WorkflowProgramCall[] = []
  const phases: string[] = []
  const logs: string[] = []
  const context = createWorkflowProgramContext({
    phase: (title) => {
      phases.push(title)
    },
    log: (message) => {
      logs.push(message)
    },
    guard: () => {},
    isFatal: () => false,
    agent: async (call) => {
      calls.push(call)
      let value: unknown
      if (call.id.startsWith('answer/')) {
        if (options.failAnswers?.includes(call.seatId)) {
          throw new Error('timed out')
        }
        value = { markdown: `answer-from-${call.seatId}` }
      } else if (call.id.startsWith('rank/')) {
        const ranking = shownLabels(call.prompt)
          .map((label, index) => `${index + 1}. ${label}`)
          .join('\n')
        value = {
          markdown:
            options.rankings?.[call.seatId] ??
            `Evaluation by ${call.seatId}.\n\nFINAL RANKING:\n${ranking}`
        }
      } else {
        if (options.failChair) {
          throw new Error('Workflow call exhausted its attempts: timed out')
        }
        value = { markdown: 'The council recommends Redis.' }
      }
      expect(validateJsonSchema(call.schema, value)).toEqual([])
      const error = call.validateSemantics(value)
      if (error) {
        throw new Error(error)
      }
      return value
    }
  })
  return { context, calls, phases, logs }
}

describe('Council revision 6 (Karpathy llm-council)', () => {
  it('runs three stages of text calls with minute-scale timeouts', async () => {
    const host = harness()
    const result = await runCouncilV6Program(host.context, config(), task)
    expect(host.phases).toEqual(['First opinions', 'Peer rankings', 'Chairman'])
    expect(host.calls.map((call) => call.id)).toEqual([
      'answer/seat-1',
      'answer/seat-2',
      'answer/seat-3',
      'answer/seat-4',
      'rank/seat-1',
      'rank/seat-2',
      'rank/seat-3',
      'chair/final'
    ])
    for (const call of host.calls) {
      expect(call.output).toBe('text')
      expect(call.schema).toBe(textAnswerSchema)
    }
    const timeouts = new Map(host.calls.map((call) => [call.id.split('/')[0], call.timeoutMs]))
    expect(Object.fromEntries(timeouts)).toEqual({
      answer: COUNCIL_ANSWER_TIMEOUT_MS,
      rank: COUNCIL_RANK_TIMEOUT_MS,
      chair: COUNCIL_CHAIR_TIMEOUT_MS
    })
    expect([COUNCIL_ANSWER_TIMEOUT_MS, COUNCIL_RANK_TIMEOUT_MS]).toEqual([900_000, 600_000])
    expect(host.calls.find((call) => call.id === 'chair/final')?.seatId).toBe('seat-1')
    expect(result.final).toEqual({ seatId: 'seat-1', markdown: 'The council recommends Redis.' })
    expect(result.answers.map((answer) => [answer.seatId, answer.label])).toEqual([
      ['seat-1', 'Response A'],
      ['seat-2', 'Response B'],
      ['seat-3', 'Response C'],
      ['seat-4', 'Response D']
    ])
  })

  it('sends the question verbatim when members may not read the workspace', async () => {
    const host = harness()
    await runCouncilV6Program(host.context, config(), task)
    const answers = host.calls.filter((call) => call.id.startsWith('answer/'))
    expect(answers.map((call) => call.prompt)).toEqual(answers.map(() => task.prompt))
    expect(answers.every((call) => call.dependencies.length === 0)).toBe(true)
  })

  it('adds only the workspace context and plain-text attached files', async () => {
    const host = harness()
    const evidence = '\n--- src/cache.ts ---\n1  export const ttl = 60\n'
    await runCouncilV6Program(host.context, config({ access: 'workspace-read' }), {
      prompt: 'Is the "ttl" right?',
      evidence
    })
    expect(host.calls[0].prompt).toBe(
      `${COUNCIL_WORKSPACE_CONTEXT}\n\nQuestion: Is the "ttl" right?\n\nAttached files:\n${evidence}`
    )
    expect(COUNCIL_WORKSPACE_CONTEXT).toBe(
      "You are one member of a council answering the question below. You are running inside the user's workspace at the current directory and may read files (read-only) to ground your answer. Cite files as path:line when you rely on them."
    )
    expect(host.calls[0].prompt).not.toContain('\\n')
    expect(host.calls[0].prompt).not.toContain('"evidence"')
  })

  it("uses Karpathy's ranking prompt verbatim over every response, including the voter's own", async () => {
    const host = harness()
    await runCouncilV6Program(host.context, config({ memberIds: ['seat-1', 'seat-2'] }), {
      prompt: 'Q?',
      evidence: 'ignored for rankings'
    })
    const rank = host.calls.find((call) => call.id === 'rank/seat-1')!
    expect(rank.prompt).toBe(
      [
        'You are evaluating different responses to the following question:',
        '',
        'Question: Q?',
        '',
        'Here are the responses from different models (anonymized):',
        '',
        'Response A:',
        'answer-from-seat-1',
        '',
        'Response B:',
        'answer-from-seat-2',
        '',
        'Your task:',
        '1. First, evaluate each response individually. For each response, explain what it does well and what it does poorly.',
        '2. Then, at the very end of your response, provide a final ranking.',
        '',
        'IMPORTANT: Your final ranking MUST be formatted EXACTLY as follows:',
        '- Start with the line "FINAL RANKING:" (all caps, with colon)',
        '- Then list the responses from best to worst as a numbered list',
        '- Each line should be: number, period, space, then ONLY the response label (e.g., "1. Response A")',
        '- Do not add any other text or explanations in the ranking section',
        '',
        'Example of the correct format for your ENTIRE response:',
        '',
        'Response A provides good detail on X but misses Y...',
        'Response B is accurate but lacks depth on Z...',
        'Response C offers the most comprehensive answer...',
        '',
        'FINAL RANKING:',
        '1. Response C',
        '2. Response A',
        '3. Response B',
        '',
        'Now provide your evaluation and ranking:'
      ].join('\n')
    )
    expect(rank.dependencies).toEqual(['answer/seat-1', 'answer/seat-2'])
    expect(rank.prompt).not.toContain('Claude')
    expect(rank.prompt).not.toContain('ignored for rankings')
  })

  it('rotates presentation order per voter while labels stay fixed; Gemini answers but never ranks', async () => {
    const host = harness()
    await runCouncilV6Program(host.context, config(), task)
    const ranks = host.calls.filter((call) => call.id.startsWith('rank/'))
    expect(ranks.map((call) => call.seatId)).toEqual(['seat-1', 'seat-2', 'seat-3'])
    expect(ranks.map((call) => shownLabels(call.prompt))).toEqual([
      ['Response A', 'Response B', 'Response C', 'Response D'],
      ['Response B', 'Response C', 'Response D', 'Response A'],
      ['Response C', 'Response D', 'Response A', 'Response B']
    ])
    for (const call of ranks) {
      expect(call.prompt).toContain('Response D:\nanswer-from-seat-4')
      expect(call.prompt).toContain(`answer-from-${call.seatId}`)
    }
    expect(host.calls.some((call) => call.id === 'rank/seat-4')).toBe(false)
    expect(host.calls.some((call) => call.id === 'answer/seat-4')).toBe(true)
  })

  it('computes street cred without self-votes and hands the chairman the de-anonymised record', async () => {
    const final = (order: string) =>
      `Notes.\n\nFINAL RANKING:\n${order
        .split('')
        .map((letter, index) => `${index + 1}. Response ${letter}`)
        .join('\n')}`
    const rankings = { 'seat-1': final('ABCD'), 'seat-2': final('BADC'), 'seat-3': final('ACBD') }
    const host = harness({ rankings })
    const result = await runCouncilV6Program(host.context, config(), task)
    // A: seat-2 2nd, seat-3 1st. B: seat-1 2nd, seat-3 3rd. C: seat-1 3rd, seat-2 4th.
    // D (Gemini, never votes): 4th, 3rd, 4th.
    expect(result.standings).toEqual([
      { label: 'Response A', seatId: 'seat-1', averageRank: 1.5, votes: 2, place: 1 },
      { label: 'Response B', seatId: 'seat-2', averageRank: 2.5, votes: 2, place: 2 },
      { label: 'Response C', seatId: 'seat-3', averageRank: 3.5, votes: 2, place: 3 },
      { label: 'Response D', seatId: 'seat-4', averageRank: 3.67, votes: 3, place: 4 }
    ])
    const letters = (ranking: string[]) => ranking.map((label) => label.at(-1)).join('')
    expect(result.ballots.map((ballot) => [ballot.callId, letters(ballot.ranking)])).toEqual([
      ['rank/seat-1', 'ABCD'],
      ['rank/seat-2', 'BADC'],
      ['rank/seat-3', 'ACBD']
    ])
    expect(result.ballots[1].evaluation).toBe(rankings['seat-2'])
    const chair = host.calls.at(-1)!
    expect(chair.dependencies).toEqual([
      'answer/seat-1',
      'answer/seat-2',
      'answer/seat-3',
      'answer/seat-4',
      'rank/seat-1',
      'rank/seat-2',
      'rank/seat-3'
    ])
    expect(chair.prompt).toContain('Model: Claude Opus 5\nResponse: answer-from-seat-1')
    expect(chair.prompt).toContain('Model: Gemini 3.8 Flash\nResponse: answer-from-seat-4')
    // BADC, written under the names the reader knows; the result keeps the reviewer's own words.
    expect(chair.prompt).toContain(
      'Model: GPT-5.6 Sol\nRanking: Notes.\n\nFINAL RANKING:\n1. GPT-5.6 Sol\n2. Claude Opus 5\n3. Gemini 3.8 Flash\n4. Grok 4.6'
    )
    const stage2 = chair.prompt.slice(
      chair.prompt.indexOf('STAGE 2 - Peer Rankings:'),
      chair.prompt.indexOf('Street cred')
    )
    expect(stage2).not.toMatch(/Response [A-D]/)
    expect(chair.prompt).not.toContain('Model: Gemini 3.8 Flash\nRanking:')
    expect(chair.prompt).toContain('| 4 | Gemini 3.8 Flash | Response D | 3.67 | 3 |')
    expect(chair.prompt).not.toContain(COUNCIL_CHAIR_WORKSPACE_NOTE)
  })

  it("uses Karpathy's chairman prompt verbatim around the street cred table", async () => {
    const host = harness({
      rankings: {
        'seat-1': 'FINAL RANKING:\n1. Response B\n2. Response A',
        'seat-2': 'FINAL RANKING:\n1. Response A\n2. Response B'
      }
    })
    await runCouncilV6Program(
      host.context,
      config({ memberIds: ['seat-1', 'seat-2'], access: 'workspace-read' }),
      { prompt: 'Q?', evidence: '' }
    )
    expect(host.calls.at(-1)!.prompt).toBe(
      [
        "You are the Chairman of an LLM Council. Multiple AI models have provided responses to a user's question, and then ranked each other's responses.",
        '',
        'Original Question: Q?',
        '',
        'STAGE 1 - Individual Responses:',
        'Model: Claude Opus 5',
        'Response: answer-from-seat-1',
        '',
        'Model: GPT-5.6 Sol',
        'Response: answer-from-seat-2',
        '',
        'STAGE 2 - Peer Rankings:',
        'Model: Claude Opus 5',
        'Ranking: FINAL RANKING:',
        '1. GPT-5.6 Sol',
        '2. Claude Opus 5',
        '',
        'Model: GPT-5.6 Sol',
        'Ranking: FINAL RANKING:',
        '1. Claude Opus 5',
        '2. GPT-5.6 Sol',
        '',
        'Street cred (average rank, lower is better; self-votes excluded):',
        '| Place | Model | Response | Average rank | Votes |',
        '| --- | --- | --- | --- | --- |',
        '| 1 | Claude Opus 5 | Response A | 1.00 | 1 |',
        '| 1 | GPT-5.6 Sol | Response B | 1.00 | 1 |',
        '',
        'Refer to council members by model name, never by response letter; the table above maps any letter a ranking still uses to its model.',
        '',
        'You may read files in the workspace to check disputed claims.',
        '',
        "Your task as Chairman is to synthesize all of this information into a single, comprehensive, accurate answer to the user's original question. Consider:",
        '- The individual responses and their insights',
        '- The peer rankings and what they reveal about response quality',
        '- Any patterns of agreement or disagreement',
        '',
        "Provide a clear, well-reasoned final answer that represents the council's collective wisdom:"
      ].join('\n')
    )
  })

  it('names repeated models by number for the chairman; a member that never answered keeps its label', async () => {
    const lineup = [...seats, seat('seat-5', 'claude', 'anthropic', 'claude-opus-5')]
    const evaluation = [
      "Response A's cache is stale. Responses B and D agree; Response C never answered.",
      '',
      'FINAL RANKING:',
      '1. Response D',
      '2. Response B',
      '3. Response A'
    ].join('\n')
    const host = harness({ failAnswers: ['seat-3'], rankings: { 'seat-1': evaluation } })
    const result = await runCouncilV6Program(
      host.context,
      config({ seats: lineup, memberIds: ['seat-1', 'seat-2', 'seat-3', 'seat-5'] }),
      task
    )
    expect(result.ballots[0]).toMatchObject({
      evaluation,
      ranking: ['Response D', 'Response B', 'Response A']
    })
    const chair = host.calls.at(-1)!
    expect(chair.prompt).toContain(
      [
        'Model: Claude Opus 5 (1)',
        "Ranking: Claude Opus 5 (1)'s cache is stale. GPT-5.6 Sol and Claude Opus 5 (2) agree; Response C never answered.",
        '',
        'FINAL RANKING:',
        '1. Claude Opus 5 (2)',
        '2. GPT-5.6 Sol',
        '3. Claude Opus 5 (1)'
      ].join('\n')
    )
    expect(chair.prompt).toContain(`\n\n${COUNCIL_CHAIR_NAMES_NOTE}\n\n`)
  })

  it('degrades when a member fails: the others are ranked and the failed seat still votes', async () => {
    const host = harness({ failAnswers: ['seat-3'] })
    const result = await runCouncilV6Program(host.context, config(), task)
    expect(result.answers.map((answer) => answer.label)).toEqual([
      'Response A',
      'Response B',
      'Response D'
    ])
    const ranks = host.calls.filter((call) => call.id.startsWith('rank/'))
    expect(ranks.map((call) => call.seatId)).toEqual(['seat-1', 'seat-2', 'seat-3'])
    for (const call of ranks) {
      expect(shownLabels(call.prompt).sort()).toEqual(['Response A', 'Response B', 'Response D'])
      expect(call.dependencies).toEqual(['answer/seat-1', 'answer/seat-2', 'answer/seat-4'])
    }
    expect(host.logs).toEqual(['Grok 4.6 did not answer; the council continues without it.'])
    expect(result.standings.map((standing) => standing.label).sort()).toEqual([
      'Response A',
      'Response B',
      'Response D'
    ])
    expect(host.calls.at(-1)?.id).toBe('chair/final')
    expect(host.calls.at(-1)?.prompt).not.toContain('answer-from-seat-3')
  })

  it('leaves out a ranking that names no response and still asks the chairman', async () => {
    const host = harness({ rankings: { 'seat-2': 'They are all good.' } })
    const result = await runCouncilV6Program(host.context, config(), task)
    expect(result.ballots.map((ballot) => ballot.reviewerSeatId)).toEqual(['seat-1', 'seat-3'])
    expect(host.logs).toEqual(['GPT-5.6 Sol did not return a ranking; its vote is left out.'])
    expect(host.calls.at(-1)?.dependencies).not.toContain('rank/seat-2')
    const rank = host.calls.find((call) => call.id === 'rank/seat-2')!
    expect(rank.validateSemantics({ markdown: 'No verdict.' })).toBe(COUNCIL_RANKING_PROBLEM)
    expect(rank.validateSemantics({ markdown: 'FINAL RANKING:\n1. Response Z' })).toBe(
      COUNCIL_RANKING_PROBLEM
    )
    expect(rank.validateSemantics({ markdown: 'FINAL RANKING:\n1. Response C' })).toBeNull()
    expect(COUNCIL_RANKING_PROBLEM).toBe(
      'Your evaluation must end with a FINAL RANKING: list naming the responses.'
    )
  })

  it('fails clearly when no member answers, before any ranking', async () => {
    const host = harness({ failAnswers: ['seat-1', 'seat-2', 'seat-3', 'seat-4'] })
    await expect(runCouncilV6Program(host.context, config(), task)).rejects.toThrow(
      'No council member answered the question.'
    )
    expect(host.calls.every((call) => call.id.startsWith('answer/'))).toBe(true)
  })

  it('fails the run when the chairman fails', async () => {
    const host = harness({ failChair: true })
    await expect(runCouncilV6Program(host.context, config(), task)).rejects.toThrow(
      'exhausted its attempts'
    )
    expect(host.calls.at(-1)?.id).toBe('chair/final')
  })

  it('refuses invalid rosters before any call, in plain words', async () => {
    const cases: [CouncilV6Config, string][] = [
      [config({ memberIds: ['seat-1'] }), 'Choose 2 to 6 council members.'],
      [config({ memberIds: ['seat-1', 'seat-1'] }), 'Choose each council member once.'],
      [
        config({ memberIds: ['seat-1', 'missing'] }),
        'A council member is no longer set up. Choose the members again.'
      ],
      [
        config({ memberIds: ['seat-1', 'seat-2', 'seat-3', 'seat-4', 'a', 'b', 'c'] }),
        'Choose 2 to 6 council members.'
      ],
      [config({ chairId: 'seat-4' }), 'Gemini answers but never chairs. Choose another chairman.'],
      [config({ chairId: 'missing' }), 'Choose a chairman.'],
      [
        config({
          seats: [...seats, seat('seat-5', 'gemini', 'google', 'gemini-3.8-flash')],
          memberIds: ['seat-4', 'seat-5']
        }),
        'Add a member other than Gemini: Gemini answers but never ranks.'
      ]
    ]
    for (const [invalid, message] of cases) {
      const host = harness()
      await expect(runCouncilV6Program(host.context, invalid, task)).rejects.toThrow(message)
      expect(host.calls).toHaveLength(0)
      expect(councilLineupProblem(invalid)).toBe(message)
    }
    expect(councilLineupProblem(config())).toBeUndefined()
  })

  it('lets a chairman sit outside the council', async () => {
    const host = harness()
    await runCouncilV6Program(
      host.context,
      config({ memberIds: ['seat-2', 'seat-4'], chairId: 'seat-1' }),
      task
    )
    expect(host.calls.map((call) => call.id)).toEqual([
      'answer/seat-2',
      'answer/seat-4',
      'rank/seat-2',
      'chair/final'
    ])
    expect(host.calls.at(-1)?.seatId).toBe('seat-1')
  })

  it('numbers repeated models so the chairman can tell them apart', () => {
    expect(
      councilSeatNames([
        seat('a', 'claude', 'anthropic', 'claude-opus-5'),
        seat('b', 'codex', 'openai', 'gpt-5.6-sol'),
        seat('c', 'claude', 'anthropic', 'claude-opus-5')
      ])
    ).toEqual(['Claude Opus 5 (1)', 'GPT-5.6 Sol', 'Claude Opus 5 (2)'])
  })

  it('bundles a text answer schema the host can enforce', () => {
    expect(() => assertWorkflowSchemaContract(textAnswerSchema)).not.toThrow()
    expect(validateJsonSchema(textAnswerSchema, { markdown: 'ok' })).toEqual([])
    expect(validateJsonSchema(textAnswerSchema, { markdown: 'ok', extra: 1 })).not.toEqual([])
    expect(validateJsonSchema(textAnswerSchema, { markdown: 'x'.repeat(64_001) })).not.toEqual([])
    expect(validateJsonSchema(textAnswerSchema, {})).not.toEqual([])
  })
})
