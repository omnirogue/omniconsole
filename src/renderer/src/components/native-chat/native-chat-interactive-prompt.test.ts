import { describe, expect, it } from 'vitest'
import {
  buildAskAnswerKeys,
  buildNativeChatApprovalKeys,
  buildCodexAskAnswerKeys,
  formatAskAnswer,
  hasAskAnswer,
  parseApprovalFromStatus,
  parseAskFromStatus,
  parseInteractivePrompt,
  type AskPrompt
} from './native-chat-interactive-prompt'

const ESC = String.fromCharCode(27)

describe('parseAskFromStatus', () => {
  it('returns null for empty/invalid input', () => {
    expect(parseAskFromStatus(null)).toBeNull()
    expect(parseAskFromStatus(undefined)).toBeNull()
    expect(parseAskFromStatus('')).toBeNull()
    expect(parseAskFromStatus('not json')).toBeNull()
    expect(parseAskFromStatus('{}')).toBeNull()
    expect(parseAskFromStatus('{"questions":[]}')).toBeNull()
  })

  it('parses the canonical AskUserQuestion shape', () => {
    const prompt = parseAskFromStatus(
      JSON.stringify({
        questions: [
          {
            question: 'Pick a color',
            header: 'Color',
            multiSelect: false,
            options: [{ label: 'Red', description: 'warm' }, { label: 'Blue' }]
          }
        ]
      })
    )
    expect(prompt).toEqual({
      questions: [
        {
          question: 'Pick a color',
          header: 'Color',
          multiSelect: false,
          options: [{ label: 'Red', description: 'warm' }, { label: 'Blue' }]
        }
      ]
    })
  })

  it('accepts string options and defaults multiSelect to false', () => {
    const prompt = parseAskFromStatus(
      JSON.stringify({ questions: [{ question: 'q', options: ['A', 'B'] }] })
    )
    expect(prompt?.questions[0]).toMatchObject({
      multiSelect: false,
      options: [{ label: 'A' }, { label: 'B' }]
    })
  })

  it('honors multiSelect: true and multiple questions', () => {
    const prompt = parseAskFromStatus(
      JSON.stringify({
        questions: [
          { question: 'q1', multiSelect: true, options: [{ label: 'X' }] },
          { question: 'q2', options: [{ label: 'Y' }] }
        ]
      })
    )
    expect(prompt?.questions).toHaveLength(2)
    expect(prompt?.questions[0]?.multiSelect).toBe(true)
    expect(prompt?.questions[1]?.multiSelect).toBe(false)
  })

  it('skips malformed question entries', () => {
    const prompt = parseAskFromStatus(
      JSON.stringify({ questions: [null, 42, { question: 'ok', options: ['A'] }] })
    )
    expect(prompt?.questions).toHaveLength(1)
    expect(prompt?.questions[0]?.question).toBe('ok')
  })
})

describe('parseApprovalFromStatus', () => {
  it('returns null for non-approval envelopes', () => {
    expect(parseApprovalFromStatus(null)).toBeNull()
    expect(parseApprovalFromStatus('not json')).toBeNull()
    expect(parseApprovalFromStatus('{}')).toBeNull()
    expect(parseApprovalFromStatus(JSON.stringify({ approval: {} }))).toBeNull()
    expect(parseApprovalFromStatus(JSON.stringify({ approval: { tool: '' } }))).toBeNull()
  })

  it('builds an Allow/Deny card from { approval: { tool, summary } }', () => {
    const approval = parseApprovalFromStatus(
      JSON.stringify({ approval: { tool: 'Bash', summary: 'rm -rf build' } })
    )
    expect(approval).toEqual({
      title: 'Allow Bash?',
      detail: 'rm -rf build',
      options: [
        { label: 'Allow', send: '1' },
        { label: 'Deny', send: ESC }
      ]
    })
  })

  it('omits detail when summary is missing', () => {
    const approval = parseApprovalFromStatus(JSON.stringify({ approval: { tool: 'Edit' } }))
    expect(approval?.title).toBe('Allow Edit?')
    expect(approval?.detail).toBeUndefined()
  })

  it('uses OMP selector actions and preserves the request identity', () => {
    const approval = parseApprovalFromStatus(
      JSON.stringify({
        ompApproval: { tool: 'bash', toolCallId: 'call-a', summary: 'cp a b' }
      })
    )!
    expect(approval).toMatchObject({
      title: 'Allow bash?',
      detail: 'cp a b',
      protocol: 'omp-selector-v1',
      requestId: 'call-a',
      options: [
        { label: 'Allow', send: 'approve' },
        { label: 'Deny', send: 'deny' }
      ]
    })
    expect(buildNativeChatApprovalKeys(approval, 'approve', 'omp')).toEqual(['\x1b[A', '\r'])
    expect(buildNativeChatApprovalKeys(approval, 'deny', 'omp')).toEqual([ESC])
    expect(buildNativeChatApprovalKeys(approval, '1', 'omp')).toEqual([])
    expect(buildNativeChatApprovalKeys(approval, 'approve', 'claude')).toEqual([])
  })

  it('refuses uncorrelated OMP envelopes and never turns remote strings into control bytes', () => {
    for (const toolCallId of [undefined, '', ' ', 42]) {
      expect(
        parseApprovalFromStatus(
          JSON.stringify({
            ompApproval: { tool: 'bash', toolCallId },
            approval: { tool: 'bash' }
          })
        )
      ).toBeNull()
    }
    const approval = parseApprovalFromStatus(JSON.stringify({ approval: { tool: 'Bash' } }))!
    expect(buildNativeChatApprovalKeys(approval, '1', 'omp')).toEqual([])
    expect(buildNativeChatApprovalKeys(approval, 'arbitrary command\r', 'claude')).toEqual([])
    expect(buildNativeChatApprovalKeys(approval, '1', 'claude')).toEqual(['1'])
    expect(buildNativeChatApprovalKeys(approval, ESC, 'claude')).toEqual([ESC])
  })
})

describe('parseInteractivePrompt', () => {
  it('returns a question card, with question taking precedence', () => {
    const card = parseInteractivePrompt(
      JSON.stringify({
        questions: [{ question: 'q', options: ['A'] }],
        approval: { tool: 'Bash', summary: 's' }
      })
    )
    expect(card?.kind).toBe('question')
  })

  it('returns an approval card when no question is present', () => {
    const card = parseInteractivePrompt(JSON.stringify({ approval: { tool: 'Bash' } }))
    expect(card?.kind).toBe('approval')
  })

  it('returns null when neither parses', () => {
    expect(parseInteractivePrompt(null)).toBeNull()
    expect(parseInteractivePrompt('{}')).toBeNull()
  })
})

describe('formatAskAnswer', () => {
  it('joins selected option labels per question, one line each', () => {
    const prompt: AskPrompt = {
      questions: [
        { question: 'q1', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] },
        { question: 'q2', multiSelect: false, options: [{ label: 'C' }] }
      ]
    }
    expect(formatAskAnswer(prompt, [{ indices: [0, 1] }, { indices: [0] }])).toBe('A, B\nC')
  })

  it('appends free-text after picked labels', () => {
    const prompt: AskPrompt = {
      questions: [{ question: 'q1', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }]
    }
    expect(formatAskAnswer(prompt, [{ indices: [0], other: '  extra ' }])).toBe('A, extra')
  })

  it('preserves empty answers as empty lines so N lines == N questions', () => {
    const prompt: AskPrompt = {
      questions: [
        { question: 'q1', multiSelect: false, options: [{ label: 'A' }] },
        { question: 'q2', multiSelect: false, options: [{ label: 'B' }] }
      ]
    }
    // Leading blank stays an empty line: '\nB' (2 lines), not 'B'.
    expect(formatAskAnswer(prompt, [{ indices: [] }, { indices: [0] }])).toBe('\nB')
  })

  it('keeps one line per question with a blank middle answer (3 questions)', () => {
    const prompt: AskPrompt = {
      questions: [
        { question: 'q1', multiSelect: false, options: [{ label: 'A' }] },
        { question: 'q2', multiSelect: false, options: [{ label: 'B' }] },
        { question: 'q3', multiSelect: false, options: [{ label: 'C' }] }
      ]
    }
    const answer = formatAskAnswer(prompt, [{ indices: [0] }, { indices: [] }, { indices: [0] }])
    expect(answer).toBe('A\n\nC')
    expect(answer.split('\n')).toHaveLength(3)
  })
})

const single = (options: string[], multiSelect = false): AskPrompt => ({
  questions: [{ question: 'q', multiSelect, options: options.map((label) => ({ label })) }]
})

describe('buildAskAnswerKeys', () => {
  it('single-select: sends the picked option NUMBER (not the label), no trailing Enter', () => {
    // STA-1860 regression: picking the 2nd option must deliver the 2nd option.
    // '2' is the selector marker Claude commits on; a label + Enter committed the
    // highlighted default (option 1) instead.
    expect(buildAskAnswerKeys(single(['Tabs', 'Spaces']), [{ indices: [1] }])).toEqual([
      { raw: '2' }
    ])
    expect(buildAskAnswerKeys(single(['Apple', 'Banana', 'Cherry']), [{ indices: [2] }])).toEqual([
      { raw: '3' }
    ])
  })

  it('single-select free text: opens "Type something" then types the answer + Enter', () => {
    expect(
      buildAskAnswerKeys(single(['Tabs', 'Spaces']), [{ indices: [], other: 'Zebra' }])
    ).toEqual([{ raw: '3' }, { text: 'Zebra' }, { raw: '\r' }])
  })

  it('multi-select: toggles each option NUMBER, then steps to Submit and confirms', () => {
    expect(
      buildAskAnswerKeys(single(['Apple', 'Banana', 'Cherry'], true), [{ indices: [0, 2] }])
    ).toEqual([{ raw: '1' }, { raw: '3' }, { raw: '\x1b[C' }, { raw: '\r' }])
  })

  // Claude Code 2.1.280, captured live: a multi-select row number only ticks the empty
  // "Type something" box, so '3' + text + Enter lost the text and un-ticked option 1.
  it('multi-select free text: arrows down to "Type something", types, leaves via Next', () => {
    const prompt: AskPrompt = {
      questions: [
        {
          question: 'q1',
          header: 'Scope',
          multiSelect: true,
          options: [{ label: 'Tabs' }, { label: 'Spaces' }]
        },
        {
          question: 'q2',
          header: 'Generosity',
          multiSelect: false,
          options: [{ label: 'Apple' }, { label: 'Banana' }]
        }
      ]
    }
    expect(
      buildAskAnswerKeys(prompt, [{ indices: [1], other: 'Zebra' }, { indices: [0] }])
    ).toEqual([
      { raw: '2' },
      { raw: '\x1b[B' },
      { raw: '\x1b[B' },
      { text: 'Zebra' },
      { raw: '\x1b[B' },
      { raw: '\r' },
      { raw: '1' },
      { raw: '\r' }
    ])
  })

  it('multi-question single-select: option numbers auto-advance, one final submit Enter', () => {
    const prompt: AskPrompt = {
      questions: [
        { question: 'q1', multiSelect: false, options: [{ label: 'Tabs' }, { label: 'Spaces' }] },
        {
          question: 'q2',
          multiSelect: false,
          options: [{ label: 'Apple' }, { label: 'Banana' }, { label: 'Cherry' }]
        }
      ]
    }
    expect(buildAskAnswerKeys(prompt, [{ indices: [1] }, { indices: [2] }])).toEqual([
      { raw: '2' },
      { raw: '3' },
      { raw: '\r' }
    ])
  })

  it('multi-question: steps past an unanswered question then submits', () => {
    const prompt: AskPrompt = {
      questions: [
        { question: 'q1', multiSelect: false, options: [{ label: 'Tabs' }, { label: 'Spaces' }] },
        { question: 'q2', multiSelect: false, options: [{ label: 'Apple' }, { label: 'Banana' }] }
      ]
    }
    expect(buildAskAnswerKeys(prompt, [{ indices: [] }, { indices: [1] }])).toEqual([
      { raw: '\x1b[C' },
      { raw: '2' },
      { raw: '\r' }
    ])
  })

  it('is empty when nothing is answered', () => {
    expect(buildAskAnswerKeys(single(['Tabs', 'Spaces']), [{ indices: [] }])).toEqual([])
  })
})

describe('buildCodexAskAnswerKeys', () => {
  it("submits the final multi-question option without Claude's extra Enter", () => {
    const prompt: AskPrompt = {
      questions: [
        { question: 'q1', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] },
        { question: 'q2', multiSelect: false, options: [{ label: 'C' }, { label: 'D' }] }
      ]
    }

    expect(buildCodexAskAnswerKeys(prompt, [{ indices: [1] }, { indices: [0] }])).toEqual([
      { raw: '2' },
      { raw: '1' }
    ])
  })

  it('adds free text as notes before committing the selected row', () => {
    expect(
      buildCodexAskAnswerKeys(single(['Tabs', 'Spaces']), [
        { indices: [1], other: 'Keep existing files' }
      ])
    ).toEqual([{ raw: '\x1b[B' }, { raw: '\t' }, { text: 'Keep existing files' }, { raw: '\r' }])
  })

  it("targets Codex's synthetic None-of-the-above row for a custom answer", () => {
    expect(
      buildCodexAskAnswerKeys(single(['Tabs', 'Spaces']), [{ indices: [], other: 'Four spaces' }])
    ).toEqual([{ raw: '\x1b[A' }, { raw: '\t' }, { text: 'Four spaces' }, { raw: '\r' }])
  })

  it('clears skipped rows and confirms the partial answer once', () => {
    const prompt: AskPrompt = {
      questions: [
        { question: 'q1', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] },
        { question: 'q2', multiSelect: false, options: [{ label: 'C' }, { label: 'D' }] }
      ]
    }

    expect(buildCodexAskAnswerKeys(prompt, [{ indices: [] }, { indices: [1] }])).toEqual([
      { raw: '\x7f' },
      { raw: '\x1b[C' },
      { raw: '2' },
      { raw: '\r' }
    ])
  })
})

describe('hasAskAnswer', () => {
  it('is true for a picked option or typed text, false when empty', () => {
    expect(hasAskAnswer(single(['A', 'B']), [{ indices: [1] }])).toBe(true)
    expect(hasAskAnswer(single(['A', 'B']), [{ indices: [], other: 'x' }])).toBe(true)
    expect(hasAskAnswer(single(['A', 'B']), [{ indices: [], other: '  ' }])).toBe(false)
    expect(hasAskAnswer(single(['A', 'B']), [])).toBe(false)
  })
})

// Claude Code 2.1.278, captured live: with `preview` on the options the selector is a
// side-by-side layout where a number only moves the highlight and Enter selects.
describe('buildAskAnswerKeys with preview options', () => {
  const preview = (question: string, header: string, labels: string[]) => ({
    question,
    header,
    multiSelect: false,
    options: labels.map((label) => ({ label, preview: `${label} preview` }))
  })
  const twoPreviewQuestions: AskPrompt = {
    questions: [
      preview('Where should routines live?', 'Placement', ['Inline', 'Group']),
      preview('How far should I go?', 'Scheduler scope', ['Fix bugs', 'Daemon'])
    ]
  }

  it('keeps the preview text when parsing the tool input', () => {
    const parsed = parseAskFromStatus(JSON.stringify(twoPreviewQuestions))
    expect(parsed?.questions[0]?.options[1]).toEqual({
      label: 'Group',
      description: undefined,
      preview: 'Group preview'
    })
  })

  it('selects each question with its number then Enter, then submits the review', () => {
    // The incident: '1', '1', Enter committed only question 1 and left question 2 open.
    expect(buildAskAnswerKeys(twoPreviewQuestions, [{ indices: [0] }, { indices: [0] }])).toEqual([
      { raw: '1' },
      { raw: '\r' },
      { raw: '1' },
      { raw: '\r' },
      { raw: '\r' }
    ])
  })

  it('answers a lone preview question with its number and Enter, no review step', () => {
    const prompt: AskPrompt = { questions: [preview('Which?', 'Pick', ['Alpha', 'Beta'])] }
    expect(buildAskAnswerKeys(prompt, [{ indices: [1] }])).toEqual([{ raw: '2' }, { raw: '\r' }])
  })

  it('carries free text as a note on the highlighted option', () => {
    const prompt: AskPrompt = { questions: [preview('Which?', 'Pick', ['Alpha', 'Beta'])] }
    expect(buildAskAnswerKeys(prompt, [{ indices: [1], other: 'my note' }])).toEqual([
      { raw: '2' },
      { raw: 'n' },
      { text: 'my note' },
      { raw: '\r' }
    ])
  })

  it('steps past an unanswered preview question before submitting', () => {
    expect(buildAskAnswerKeys(twoPreviewQuestions, [{ indices: [1] }, { indices: [] }])).toEqual([
      { raw: '2' },
      { raw: '\r' },
      { raw: '\x1b[C' },
      { raw: '\r' }
    ])
  })
})
