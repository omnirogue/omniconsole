import { describe, expect, it } from 'vitest'
import type { PlannedItem, PreparedFields } from './session-prep-types'
import { checkPreparedFields, renderDirectPrompt, renderSessionPrompt } from './session-prep-prompt'

const item: PlannedItem = {
  title: 'Login fix',
  ask: 'Fix the login timeout',
  anchor: 'login timeout',
  direct: false,
  changesCode: true
}

function fields(overrides: Partial<PreparedFields> = {}): PreparedFields {
  return {
    title: 'Login fix',
    outcome: 'Existing users can sign in.',
    doneWhen: ['Login test passes', 'Sign-in accepts a valid account'],
    decided: [],
    references: [],
    constraints: [],
    assumptions: [],
    blockingQuestion: null,
    changesCode: true,
    ...overrides
  }
}

describe('checkPreparedFields', () => {
  it('flags an empty outcome', () => {
    const failures = checkPreparedFields(fields({ outcome: '  ' }), 'Fix login')
    expect(failures.some((failure) => failure.code === 'structure')).toBe(true)
  })

  it('flags fewer than 2 doneWhen items', () => {
    const failures = checkPreparedFields(fields({ doneWhen: ['one check'] }), 'Fix login')
    expect(failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'structure', detail: expect.stringContaining('doneWhen') })
      ])
    )
  })

  it.each([
    ['[TBD]', '[TBD]'],
    ['[TODO]', '[TODO]'],
    ['[TK]', '[TK]'],
    ['[FILL IN]', '[FILL IN]'],
    ['[FILL_IN]', '[FILL_IN]'],
    ['[FILL-IN]', '[FILL-IN]'],
    ['[INSERT name here]', '[INSERT name here]'],
    ['[NEW NAME]', '[NEW NAME]'],
    ['[WHICH ONE]', '[WHICH ONE]'],
    ['[NAME/EMAIL]', '[NAME/EMAIL]'],
    ['[CUSTOMER NAME]', '[CUSTOMER NAME]'],
    ['still TBD later', 'TBD'],
    ['fill ??? this', '???'],
    ['please <fill in> the owner', '<fill in>']
  ])('flags placeholder form %s', (outcome, snippet) => {
    const failures = checkPreparedFields(fields({ outcome: `Done with ${outcome}.` }), 'Fix login')
    expect(
      failures.some((failure) => failure.code === 'placeholder' && failure.detail.includes(snippet))
    ).toBe(true)
  })

  it('does not flag [id] inside a reference path', () => {
    const failures = checkPreparedFields(
      fields({
        references: [{ path: 'src/routes/[id].tsx', why: 'dynamic route' }]
      }),
      'Fix login'
    )
    expect(failures.filter((failure) => failure.code === 'placeholder')).toEqual([])
  })

  it.each([
    ['deploy', 'deploy this to production', 'deploy'],
    ['force', 'then force-push the branch', 'force-push'],
    ['destroy', 'drop table users afterwards', 'drop table'],
    ['money', 'issue a refund to the user', 'refund'],
    ['send', 'send an email to the team', 'send an email']
  ])('flags unrequested %s risk', (family, outcome, phrase) => {
    const failures = checkPreparedFields(fields({ outcome }), 'Fix the login timeout')
    expect(
      failures.some(
        (failure) =>
          failure.code === 'unrequested-risk' &&
          failure.detail.startsWith(`${family}:`) &&
          failure.detail.includes(phrase)
      )
    ).toBe(true)
  })

  it.each([
    ['deploy', 'Please deploy the login fix', 'deploy this to production'],
    ['force', 'You may force-push this branch', 'then force-push the branch'],
    ['destroy', 'Please drop table leftovers', 'drop table users afterwards'],
    ['money', 'Issue a refund if needed', 'issue a refund to the user'],
    ['send', 'Please send an email to support', 'send an email to the team']
  ])('does not flag %s when the request already names it', (_family, request, outcome) => {
    const failures = checkPreparedFields(fields({ outcome }), request)
    expect(failures.filter((failure) => failure.code === 'unrequested-risk')).toEqual([])
  })
})

describe('renderSessionPrompt', () => {
  it('omits empty list sections and formats provenance', () => {
    const text = renderSessionPrompt({
      fields: fields(),
      item,
      index: 0,
      request: 'Fix the login timeout',
      batchId: 'batch-1',
      ask: null,
      siblings: [],
      unresolved: []
    })
    expect(text).toContain('Login fix')
    expect(text).toContain('Your request (verbatim): "Fix the login timeout"')
    expect(text).toContain('## Outcome')
    expect(text).toContain('## Done when')
    expect(text).toMatch(/^- DW1\. /m)
    expect(text).toContain('## Report')
    expect(text).toContain('DW1 PASS — ')
    expect(text).not.toContain('## Decided already')
    expect(text).not.toContain('## References')
    expect(text).not.toContain('## Constraints')
    expect(text).not.toContain('## Assumptions made while preparing')
    expect(text).not.toContain('## Open issues the preparer could not resolve')
    expect(text).not.toContain('This session covers:')
    expect(text).not.toContain('## Ask first')
    expect(text).toContain('## How to work')
    expect(
      text.endsWith('Prepared by OmniConsole from your message (batch batch-1, item 1).')
    ).toBe(true)
  })

  it('renders siblings, filled sections, and ask with options', () => {
    const text = renderSessionPrompt({
      fields: fields({
        decided: ['Keep the current provider'],
        references: [{ path: 'src/auth.ts', why: 'login handler' }],
        constraints: ['No password-policy change'],
        assumptions: ['Keep current copy']
      }),
      item,
      index: 2,
      request: 'Fix the login timeout',
      batchId: 'b2',
      ask: { question: 'Which environment?', options: ['staging', 'prod'] },
      siblings: ['Docs pass'],
      unresolved: [{ code: 'not-ready', detail: 'success checks are vague' }]
    })
    expect(text).toContain(
      'This session covers: Fix the login timeout. Sibling sessions in the same batch handle: Docs pass. Do not do their work.'
    )
    expect(text).toContain('## Decided already')
    expect(text).toContain('- Keep the current provider')
    expect(text).toContain('- `src/auth.ts` — login handler')
    expect(text).toContain('## Constraints')
    expect(text).toContain('## Assumptions made while preparing')
    expect(text).toContain('## Open issues the preparer could not resolve')
    expect(text).toContain('- success checks are vague')
    expect(text).toContain('## Ask first')
    expect(text).toContain(
      'Before you start, ask the person this with your question tool (AskUserQuestion), then continue with their answer: Which environment? Options: staging / prod'
    )
    expect(text).toContain('(batch b2, item 3).')
  })

  it('omits Options when the ask has none', () => {
    const text = renderSessionPrompt({
      fields: fields(),
      item,
      index: 0,
      request: 'Fix the login timeout',
      batchId: 'b3',
      ask: { question: 'Who is the recipient?', options: [] },
      siblings: [],
      unresolved: []
    })
    expect(text).toContain(
      'Before you start, ask the person this with your question tool (AskUserQuestion), then continue with their answer: Who is the recipient?'
    )
    expect(text).not.toContain('Options:')
  })
})

describe('renderDirectPrompt', () => {
  it('keeps the full request first and scopes a direct or fallback item to its siblings', () => {
    const request = '  Fix the login timeout and write the onboarding guide.\nKeep both bounded.  '
    const text = renderDirectPrompt({
      item,
      index: 0,
      request,
      siblings: ['Write onboarding guide'],
      batchId: 'split',
      note: 'Launched with your own words: preparation failed'
    })
    expect(text.startsWith(`${request}\n\n`)).toBe(true)
    expect(text).toContain('This session covers: Fix the login timeout.')
    expect(text).toContain(
      'Sibling sessions in the same batch handle: Write onboarding guide. Do not do their work.'
    )
    expect(text).toContain('Launched with your own words: preparation failed')
  })

  it('leaves a single-item fallback unchanged when siblings are empty', () => {
    const input = { item, index: 0, request: 'Fix the login timeout', batchId: 'single' }
    expect(renderDirectPrompt({ ...input, siblings: [] })).toBe(renderDirectPrompt(input))
    expect(renderDirectPrompt(input)).not.toContain('This session covers:')
  })

  it('keeps the exact request when the planned ask normalizes equal', () => {
    const text = renderDirectPrompt({
      item: { ...item, ask: 'Fix the login timeout!' },
      index: 0,
      request: 'fix the login timeout',
      batchId: 'b4'
    })
    expect(text).not.toContain('Your request (verbatim):')
    expect(text.startsWith('fix the login timeout\n')).toBe(true)
    expect(text).toContain(
      'Prepared by OmniConsole from your message (batch b4, item 1); launched as written.'
    )
  })

  it('uses the original request instead of the planned paraphrase and keeps the note', () => {
    const text = renderDirectPrompt({
      item,
      index: 1,
      request: 'Create a session for the login timeout',
      batchId: 'b5',
      note: 'Preparation failed twice; launched your words.'
    })
    expect(text).not.toContain('Fix the login timeout')
    expect(text.startsWith('Create a session for the login timeout\n')).toBe(true)
    expect(text).toContain('Preparation failed twice; launched your words.')
    expect(text).toContain('(batch b5, item 2); launched as written.')
  })

  it('drops risky planner additions and preserves original whitespace', () => {
    const request = '  Fix the timeout.\nKeep this bounded.  '
    const text = renderDirectPrompt({
      item: { ...item, ask: 'Fix the timeout and deploy to production' },
      index: 0,
      request,
      batchId: 'fallback'
    })
    expect(text.startsWith(`${request}\n`)).toBe(true)
    expect(text).not.toContain('deploy')
  })

  it('names the agent, model and effort the session launches with', () => {
    const text = renderDirectPrompt({
      item,
      index: 0,
      request: 'fix the login timeout',
      batchId: 'b6',
      launch: { agent: 'codex', model: 'gpt-5.6-sol', effort: 'high' }
    })
    expect(text).toContain(
      '(batch b6, item 1; on codex, gpt-5.6-sol, high effort); launched as written.'
    )
    const prepared = renderSessionPrompt({
      fields: fields(),
      item,
      index: 1,
      request: 'Fix the login timeout',
      batchId: 'b7',
      ask: null,
      siblings: [],
      unresolved: [],
      launch: { agent: 'claude', effort: 'medium' }
    })
    expect(
      prepared.endsWith(
        'Prepared by OmniConsole from your message (batch b7, item 2; on claude, medium effort).'
      )
    ).toBe(true)
  })
})
