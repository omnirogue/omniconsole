// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { AttentionNextStepArm } from './AttentionNextStepArm'
afterEach(cleanup)
it('routes new follow-ups to the launched conversation without a legacy editor', () => {
  render(<AttentionNextStepArm />)
  expect(screen.getByText(/Add follow-ups from the launched conversation/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Add Next' })).toBeNull()
  expect(screen.queryByText(/Templates|Plan levels|Rounds/)).toBeNull()
  // Why: the armed-draft chip was unreachable state; nothing may bring it back.
  expect(screen.queryByText(/^Then:/)).toBeNull()
  expect(screen.queryByRole('button', { name: 'Forget the next step' })).toBeNull()
})
