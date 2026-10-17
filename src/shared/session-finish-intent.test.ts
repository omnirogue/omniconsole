import { expect, it } from 'vitest'
import { requestedSessionFinish, assertSessionFinishIntent } from './session-finish-intent'
import { validateNextOutcomeIntentSubmission } from './next-outcome-intent-definition'

it.each([
  ['send to Gamma and mark this session as saved when done', 'save'],
  ['Please save this session when done.', 'save'],
  ['When you are done, close this session.', 'end'],
  ['Keep this session open.', 'me'],
  ['Can you save this session when done?', 'save'],
  ['Please close this session after it finishes.', 'end'],
  ['Could you please keep this session open?', 'me'],
  ['Can you send to Gamma and mark this session as saved when done?', 'save'],
  ['Save this session when done. What is its title?', 'save']
])('admits the direct disposition request: %s', (prompt, action) => {
  expect(requestedSessionFinish(prompt)).toEqual({ action })
})

it.each([
  'Do not save this session when done.',
  'Do not close this session.',
  'Should I close this session?',
  'Could you explain whether I should save this session?',
  'Could you not close this session?',
  'Could you close this session if I approve later?',
  'Can you print "save this session when done"?',
  'Save the report to /work/session.md.',
  'Print "save this session when done".',
  '> close this session when done',
  '```text\nclose this session when done\n```',
  '<reference>save this session when done</reference>',
  'Example:\nclose this session when done',
  'If I approve later, close this session.',
  'Save this session and close this session.',
  'Save this session and do not save this session.',
  'Someone told me:\nclose this session',
  '"Do not" close this session'
])('does not infer authority from %s', (prompt) => {
  expect(requestedSessionFinish(prompt)).toBeUndefined()
  expect(() => assertSessionFinishIntent({ action: 'end' }, prompt)).toThrow('explicitly')
})

it('binds a source-only finish without a writer and refuses a changed source prompt', () => {
  const prompt = 'Save this session when done.'
  const submission = {
    expectedRevision: 0,
    sourcePrompt: prompt,
    sessionFinish: { action: 'save' },
    outcomes: [
      {
        id: 'source',
        title: 'Finish this session',
        finish: 'complete',
        dependsOn: [],
        conditions: [{ id: 'done', kind: 'session', target: 'tab:leaf' }],
        actions: []
      }
    ]
  }
  expect(
    validateNextOutcomeIntentSubmission(submission, {
      prompt,
      expectedRevision: 0,
      outcomes: []
    }).sessionFinish
  ).toEqual({ action: 'save' })
  expect(() =>
    validateNextOutcomeIntentSubmission(submission, {
      prompt: 'Keep this session open.',
      expectedRevision: 0,
      outcomes: []
    })
  ).toThrow('Source prompt')
})
