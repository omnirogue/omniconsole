import { createHash } from 'node:crypto'
import { snapshotDecisionRequest, type DecisionRequest } from '../../shared/structured-decisions'

export type DecisionExperimentFixture = {
  readonly id: string
  readonly request: DecisionRequest
  readonly fingerprint: string
  readonly expected: {
    readonly intent: 'inspect' | 'modify' | 'other'
    readonly completeness: 0 | 1 | 2
    readonly requestsChange: boolean
  }
}

function fixture(
  id: string,
  requestText: string,
  expected: DecisionExperimentFixture['expected']
): DecisionExperimentFixture {
  const request = snapshotDecisionRequest({
    capability: 'experiment.known-answer',
    model: 'jev-1.13.0',
    state: { request: requestText },
    questions: {
      intent: {
        type: 'choice',
        instructions: 'Classify the operation explicitly requested by the text in state.request.',
        criteria: {
          inspect: 'Read, inspect, describe, or summarize file contents without changing files.',
          modify: 'Explicitly create, edit, or delete file contents.',
          other: 'Neither file inspection nor file modification is requested.'
        }
      },
      completeness: {
        type: 'score',
        instructions:
          'Assess the goal in state.request. A named target is a specific file name or path; "a file" is not a named target. Statements that request no action do not supply a goal.',
        criteria: [
          'No inspection or modification goal is requested.',
          'An inspection or modification goal is requested, but no specific target file is named.',
          'An inspection or modification goal is requested and a specific target file is named.'
        ]
      },
      requestsChange: {
        type: 'noul',
        instructions: 'Does state.request explicitly ask to create, edit, or delete file contents?',
        criteria: {
          true: 'The request explicitly asks for a file change.',
          false:
            'The request does not ask for a file change, or explicitly asks to leave files unchanged.'
        }
      }
    }
  })
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ state: request.state, questions: request.questions }))
    .digest('hex')
  return Object.freeze({
    id,
    request,
    fingerprint,
    expected: Object.freeze({ ...expected })
  })
}

export const decisionExperimentFixtures: readonly DecisionExperimentFixture[] = Object.freeze([
  fixture(
    'inspect-named-file',
    'Read fixtures/guide.txt and report its title. Do not change any file.',
    { intent: 'inspect', completeness: 2, requestsChange: false }
  ),
  fixture(
    'modify-named-file',
    'Edit fixtures/guide.txt to replace its title "Draft" with "Guide".',
    { intent: 'modify', completeness: 2, requestsChange: true }
  ),
  fixture(
    'inspect-unnamed-file',
    'Inspect a file and describe its current contents without editing it. I have not selected which file.',
    { intent: 'inspect', completeness: 1, requestsChange: false }
  ),
  fixture(
    'modify-unnamed-file',
    'Edit a file to correct spelling mistakes. I have not selected which file.',
    { intent: 'modify', completeness: 1, requestsChange: true }
  ),
  fixture('unrelated-greeting', 'Hello! I hope you are having a pleasant day.', {
    intent: 'other',
    completeness: 0,
    requestsChange: false
  }),
  fixture('no-task-requested', 'There is no task to do and no file change requested.', {
    intent: 'other',
    completeness: 0,
    requestsChange: false
  })
])
