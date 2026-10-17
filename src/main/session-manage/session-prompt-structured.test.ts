import { describe, expect, it } from 'vitest'
import type {
  AgentJournalApprovalItem,
  AgentJournalQuestionItem,
  AgentJournalRenderItem
} from '../../shared/agent-session-journal-types'
import { selectSessionAnswer } from './session-manage-answer'
import { readStructuredSessionPrompt } from './session-prompt-structured'

const resolution = {
  state: 'pending',
  selectedOptionId: null,
  resolvedBy: null,
  resolvedAt: null
} as const
const approval: AgentJournalApprovalItem = {
  kind: 'approval',
  title: 'Allow Bash?',
  detail: '{"command":"pwd"}',
  resolution,
  options: [
    { id: 'allowForSession', label: 'Allow for this session' },
    { id: 'allow', label: 'Allow' },
    { id: 'deny', label: 'Deny' }
  ]
}

function item(body: AgentJournalApprovalItem | AgentJournalQuestionItem): AgentJournalRenderItem {
  return { itemId: 'prompt', revision: 4, sequence: 9, observedAt: 100, body }
}

/** Claude's own shape (`claude-structured-prompt-items.ts`): the item mirrors its one question. */
function claudeQuestion(
  overrides: Partial<AgentJournalQuestionItem> = {}
): AgentJournalQuestionItem {
  const options = [
    { id: 'q1:choice-1', label: 'Existing parser' },
    { id: 'q1:choice-2', label: 'A new parser', description: 'Rewrite it' }
  ]
  return {
    kind: 'question',
    question: 'Which parser?',
    options,
    freeTextQuestionId: 'q1',
    questions: [
      {
        id: 'q1',
        question: 'Which parser?',
        header: 'Parser',
        multiSelect: false,
        options,
        freeTextQuestionId: 'q1'
      }
    ],
    resolution,
    ...overrides
  }
}

const read = (body: AgentJournalApprovalItem | AgentJournalQuestionItem) =>
  readStructuredSessionPrompt('chat', { fence: 1, items: [item(body)] })

describe('structured prompt observation', () => {
  it('preserves the revision/fence and maps one-time allow by provider id', () => {
    const prompt = readStructuredSessionPrompt('chat', { fence: 7, items: [item(approval)] })!
    expect(prompt.delivery).toMatchObject({
      kind: 'structured',
      itemId: 'prompt',
      revision: 4,
      fence: 7
    })
    expect(selectSessionAnswer(prompt, { kind: 'allow' }, { kind: 'cli' })).toMatchObject({
      n: 2,
      value: 'allow'
    })
    expect(prompt.ask.options[0]).toEqual({ n: 1, label: 'Allow for this session' })
  })

  it('recognizes Codex accept, never acceptForSession', () => {
    const prompt = readStructuredSessionPrompt('chat', {
      fence: 1,
      items: [
        item({
          ...approval,
          options: [
            { id: 'acceptForSession', label: 'Allow for this session' },
            { id: 'accept', label: 'Allow' },
            { id: 'decline', label: 'Deny' }
          ]
        })
      ]
    })!
    expect(selectSessionAnswer(prompt, { kind: 'allow' }, { kind: 'cli' }).value).toBe('accept')
    expect(selectSessionAnswer(prompt, { kind: 'deny' }, { kind: 'cli' }).value).toBe('decline')
  })

  it.each([null, '', 'pwd\n[OmniConsole: output truncated — 999 bytes total, digest abc]'])(
    'refuses allow on missing/truncated detail %s',
    (detail) => {
      const prompt = readStructuredSessionPrompt('chat', {
        fence: 1,
        items: [item({ ...approval, detail })]
      })!
      expect(() => selectSessionAnswer(prompt, { kind: 'allow' }, { kind: 'cli' })).toThrow(
        'cannot be read completely'
      )
      expect(selectSessionAnswer(prompt, { kind: 'deny' }, { kind: 'cli' }).value).toBe('deny')
    }
  )

  it('includes option descriptions in the fingerprint and hard-stop checks', () => {
    const options = [{ id: 'safe-name', label: 'Go ahead', description: 'deploy the app' }]
    const question = claudeQuestion({
      question: 'Which next step?',
      options,
      freeTextQuestionId: undefined,
      questions: [{ id: 'q1', question: 'Which next step?', multiSelect: false, options }]
    })
    const prompt = readStructuredSessionPrompt('chat', { fence: 1, items: [item(question)] })!
    expect(prompt.ask.options[0]?.label).toContain('deploy the app')
    expect(() =>
      selectSessionAnswer(prompt, { kind: 'choose', choice: 1 }, { kind: 'cli' })
    ).toThrow('hard stop')
  })

  it('refuses multiple pending prompts and grouped or multi-select questions', () => {
    expect(
      readStructuredSessionPrompt('chat', { fence: 1, items: [item(approval), item(approval)] })
    ).toBeNull()
    const q = { id: 'q1', question: 'Which?', multiSelect: true, options: [] }
    const body: AgentJournalQuestionItem = {
      kind: 'question',
      question: 'Which?',
      options: [],
      questions: [q],
      resolution
    }
    expect(readStructuredSessionPrompt('chat', { fence: 1, items: [item(body)] })).toBeNull()
    expect(
      readStructuredSessionPrompt('chat', {
        fence: 1,
        items: [item({ ...body, questions: [{ ...q, multiSelect: false }, q] })]
      })
    ).toBeNull()
    expect(
      readStructuredSessionPrompt('chat', {
        fence: 1,
        items: [item({ ...approval, resolution: { ...resolution, state: 'resolved' } })]
      })
    ).toBeNull()
  })

  // MAJOR-4-B: the item's own question and options must be its full question record's.
  it('reads a single-choice question whose record matches the item', () => {
    const prompt = read(claudeQuestion())!
    expect(prompt.ask).toMatchObject({
      kind: 'question',
      text: 'Which parser?\nParser',
      options: [
        { n: 1, label: 'Existing parser' },
        { n: 2, label: 'A new parser — Rewrite it' }
      ]
    })
    expect(prompt.commandText).toEqual(['Parser'])
    expect(prompt.delivery).toMatchObject({ kind: 'structured', freeTextQuestionId: 'q1' })
  })

  it.each([
    ['no question record (the item may summarize something else)', { questions: undefined }],
    ['an empty question record', { questions: [] }],
    [
      'a multi-select question',
      { questions: [{ ...claudeQuestion().questions![0]!, multiSelect: true }] }
    ],
    [
      'a record asking something else',
      { questions: [{ ...claudeQuestion().questions![0]!, question: 'Deploy to production?' }] }
    ],
    [
      'a record with other option ids',
      {
        questions: [
          {
            ...claudeQuestion().questions![0]!,
            options: [
              { id: 'q1:choice-2', label: 'Existing parser' },
              { id: 'q1:choice-1', label: 'A new parser', description: 'Rewrite it' }
            ]
          }
        ]
      }
    ],
    [
      'a record with another option description',
      {
        questions: [
          {
            ...claudeQuestion().questions![0]!,
            options: [
              { id: 'q1:choice-1', label: 'Existing parser' },
              { id: 'q1:choice-2', label: 'A new parser', description: 'and deploy it' }
            ]
          }
        ]
      }
    ],
    [
      'a record with another free-text address',
      { questions: [{ ...claudeQuestion().questions![0]!, freeTextQuestionId: 'q2' }] }
    ],
    ['no options', { options: [] }],
    [
      'two matching records',
      { questions: [claudeQuestion().questions![0]!, claudeQuestion().questions![0]!] }
    ],
    [
      'a record relabelling an option under the same id',
      {
        questions: [
          {
            ...claudeQuestion().questions![0]!,
            options: [
              { id: 'q1:choice-1', label: 'Allow for this session' },
              { id: 'q1:choice-2', label: 'A new parser', description: 'Rewrite it' }
            ]
          }
        ]
      }
    ],
    [
      'a record with no options while the item has some',
      { questions: [{ ...claudeQuestion().questions![0]!, options: [] }] }
    ]
  ])('refuses a question with %s', (_name, change) => {
    expect(read(claudeQuestion(change as Partial<AgentJournalQuestionItem>))).toBeNull()
  })

  it('refuses an approval with no options and a body with none at all, without throwing', () => {
    expect(read({ ...approval, options: [] })).toBeNull()
    expect(
      read({ ...approval, options: undefined } as unknown as AgentJournalApprovalItem)
    ).toBeNull()
  })

  it('checks the question header for hard stops', () => {
    const question = claudeQuestion()
    question.questions = [{ ...question.questions![0]!, header: 'Deploy to production' }]
    expect(() =>
      selectSessionAnswer(read(question)!, { kind: 'choose', choice: 1 }, { kind: 'cli' })
    ).toThrow('hard stop')
  })

  it.each(['question', 'header'] as const)(
    'refuses a persistent permission hidden in the %s',
    (field) => {
      const body = claudeQuestion()
      if (field === 'question') {
        body.question = 'Always allow this command?'
      }
      body.options = [
        { id: 'q1:choice-1', label: 'Yes' },
        { id: 'q1:choice-2', label: 'No' }
      ]
      body.questions = [
        {
          ...body.questions![0]!,
          question: body.question,
          options: body.options,
          ...(field === 'header' ? { header: 'Always allow this command' } : {})
        }
      ]
      const prompt = read(body)!
      expect(prompt.ask.text).toContain('Always allow')
      expect(() =>
        selectSessionAnswer(prompt, { kind: 'choose', choice: 1 }, { kind: 'cli' })
      ).toThrow('persistent')
      expect(() =>
        selectSessionAnswer(prompt, { kind: 'text', text: 'Yes' }, { kind: 'cli' })
      ).toThrow('persistent')
    }
  )

  it('shows the independent Codex executable and question headers in the public prompt', () => {
    const command = 'git status --short'
    const prompt = read({
      ...approval,
      title: 'Run a command?',
      detail: 'Inspect the working tree',
      command
    })!
    expect(prompt.ask.text).toContain(command)
    expect(prompt.ask.text).toContain('Inspect the working tree')
    expect(read(claudeQuestion())?.ask.text).toContain('Parser')
  })

  // MINOR-5: the same control-character gate as a terminal screen.
  it.each([
    ['approval detail', read.bind(null, { ...approval, detail: 'pwd\x1b[20~' })],
    ['approval title', read.bind(null, { ...approval, title: 'Allow\x07 Bash?' })],
    [
      'option label',
      read.bind(null, {
        ...approval,
        options: [
          { id: 'allow', label: 'Allow\x1b[2K' },
          { id: 'deny', label: 'Deny' }
        ]
      })
    ],
    [
      'option id',
      read.bind(null, {
        ...approval,
        options: [
          { id: 'allow\x00', label: 'Allow' },
          { id: 'deny', label: 'Deny' }
        ]
      })
    ],
    [
      'option description',
      read.bind(null, {
        ...approval,
        options: [
          { id: 'allow', label: 'Allow', description: 'once\x1b]0;x\x07' },
          { id: 'deny', label: 'Deny' }
        ]
      })
    ],
    [
      'question text',
      () => {
        const question = claudeQuestion({ question: 'Which\x1b[1A parser?' })
        question.questions = [{ ...question.questions![0]!, question: question.question }]
        return read(question)
      }
    ]
  ])('refuses control characters in the %s', (_name, readIt) => {
    expect(readIt()).toBeNull()
  })

  it('fingerprints option ids, so a persistent id behind a one-time label is another prompt', () => {
    const once = read(approval)!
    const session = read({
      ...approval,
      options: [
        { id: 'allowForSession', label: 'Allow for this session' },
        { id: 'allowForSession', label: 'Allow' },
        { id: 'deny', label: 'Deny' }
      ]
    })!
    expect(session.ask.options).toEqual(once.ask.options)
    expect(session.ask.fingerprint).not.toBe(once.ask.fingerprint)
  })

  // MINOR-R2-4: Codex items carry no question record, so they are refused (known, accepted).
  it('refuses a Codex structured question, which carries no question record', () => {
    const codex: AgentJournalQuestionItem = {
      kind: 'question',
      question: 'Which parser should I use?',
      options: [
        { id: 'codex-q:existing', label: 'Existing parser' },
        { id: 'codex-q:new', label: 'A new parser' }
      ],
      freeTextQuestionId: 'codex-q',
      resolution
    }
    expect(read(codex)).toBeNull()
  })

  // R2-MINOR-3: the control-character gate reaches the header and the free-text address.
  it.each([
    ['question header', { header: 'Parser\x1b[2K' }],
    ['free-text address', { freeTextQuestionId: 'q1\x00' }]
  ])('refuses control characters in the %s', (_name, change) => {
    const question = claudeQuestion(
      'freeTextQuestionId' in change ? { freeTextQuestionId: change.freeTextQuestionId } : {}
    )
    question.questions = [{ ...question.questions![0]!, ...change }]
    expect(read(question)).toBeNull()
  })

  // R2-MAJOR-4: the structured detail alone carrying a hard stop refuses --allow.
  it('refuses --allow when only the approval detail names a hard stop, and still denies', () => {
    const prompt = read({
      ...approval,
      title: 'Allow Bash?',
      detail: '{"command":"git push --force origin main"}'
    })!
    expect(prompt.readable).toBe(true)
    expect(() => selectSessionAnswer(prompt, { kind: 'allow' }, { kind: 'cli' })).toThrow(
      'hard stop'
    )
    expect(selectSessionAnswer(prompt, { kind: 'deny' }, { kind: 'cli' }).value).toBe('deny')
  })

  // A persistent or scoped provider id is never the one-time allow, whatever its label says.
  it.each(['allowForSession', 'acceptForSession', 'allowAlways', 'always'])(
    'refuses --allow for the id %s labelled "Allow"',
    (id) => {
      const prompt = read({
        ...approval,
        options: [
          { id, label: 'Allow' },
          { id: 'deny', label: 'Deny' }
        ]
      })!
      expect(prompt.options[0]?.role).toBeUndefined()
      expect(() => selectSessionAnswer(prompt, { kind: 'allow' }, { kind: 'cli' })).toThrow(
        'no unambiguous one-time allow'
      )
    }
  )
  it('refuses a clipped question header and fingerprints complete headers', () => {
    const body = claudeQuestion()
    const first = read(body)!
    body.questions = [{ ...body.questions![0]!, header: 'Deplo…' }]
    const clipped = read(body)!
    expect(clipped.readable).toBe(false)
    expect(clipped.ask.fingerprint).not.toBe(first.ask.fingerprint)
    expect(() =>
      selectSessionAnswer(clipped, { kind: 'choose', choice: 1 }, { kind: 'cli' })
    ).toThrow('cannot be read completely')
  })

  it('never marks an option persistent in its description as a one-time allow', () => {
    const prompt = read({
      ...approval,
      options: [
        { id: 'allow', label: 'Allow', description: 'Allow for this session' },
        { id: 'deny', label: 'Deny' }
      ]
    })!
    expect(prompt.options[0]?.role).toBeUndefined()
    expect(() => selectSessionAnswer(prompt, { kind: 'allow' }, { kind: 'cli' })).toThrow(
      'no unambiguous one-time allow'
    )
  })
})
