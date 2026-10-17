import { expect, it } from 'vitest'
import { refusal } from './console-workflow-refusal'

it('shows the console’s string detail on a validation refusal', () => {
  expect(refusal({ detail: 'wait requires a reason and a follow-up target' }, 422)).toMatchObject({
    ok: false,
    error: { message: 'wait requires a reason and a follow-up target', status: 422 }
  })
})

it('preserves validation field locations and reasons from FastAPI', () => {
  expect(
    refusal({ detail: [{ loc: ['body', 'reason'], msg: 'Field required' }] }, 422)
  ).toMatchObject({
    error: { message: 'body.reason: Field required' }
  })
})

it('prefers the hub’s explicit refusal code and message', () => {
  expect(
    refusal(
      {
        error: { code: 'lifecycle_conflict', message: 'Resolve the saved wait' },
        detail: 'fallback'
      },
      409
    )
  ).toMatchObject({
    error: { code: 'lifecycle_conflict', message: 'Resolve the saved wait' }
  })
})
