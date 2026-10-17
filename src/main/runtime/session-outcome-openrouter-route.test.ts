import { expect, it } from 'vitest'
import {
  sessionOutcomeActionKey,
  sessionOutcomeActionSchema,
  type SessionOutcomeAttempt
} from '../../shared/session-outcome-types'
import { sessionOutcomeAttemptAction } from './session-outcome-task-continuation'
import { sessionOutcomeStepSignature } from './session-outcome-revision'

const route = {
  agent: 'omp' as const,
  model: 'openrouter/x-ai/grok-exact:free',
  openrouterCandidates: ['x-ai/grok-exact:free', 'google/gemini-exact']
}
it('includes ordered OpenRouter routing in the persisted step signature', () => {
  const step = { id: 'step', prompt: 'Do the task', status: 'queued' as const, ...route }
  expect(sessionOutcomeStepSignature(step)).not.toBe(
    sessionOutcomeStepSignature({ ...step, openrouterCandidates: undefined })
  )
})
it('roundtrips new action identities without changing old persisted action keys', () => {
  const action = sessionOutcomeActionSchema.parse({
    id: 'finish',
    instruction: 'Finish',
    conditionIds: ['done'],
    authority: 'existing-user-authority',
    ...route
  })
  const old = { ...action, openrouterCandidates: undefined }
  expect(JSON.parse(sessionOutcomeActionKey(old))).toHaveLength(7)
  const attempt = { actionKey: sessionOutcomeActionKey(action) } as SessionOutcomeAttempt
  expect(sessionOutcomeAttemptAction(attempt)).toEqual(action)
  expect(
    sessionOutcomeAttemptAction({ ...attempt, actionKey: sessionOutcomeActionKey(old) })
  ).toEqual(old)
})
