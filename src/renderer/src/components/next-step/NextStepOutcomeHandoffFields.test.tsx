// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { NextStepOutcomeStep } from '../../../../shared/next-step-draft'
import { HandoffFields } from './NextStepOutcomeHandoffFields'

vi.mock('./NextStepActorFields', () => ({ ActorFields: () => null }))
afterEach(cleanup)

function mount(reviewRounds: number | undefined, reviewRepair = false) {
  const onChange = vi.fn()
  const step: Extract<NextStepOutcomeStep, { kind: 'handoff' }> = {
    id: 'next-agent',
    kind: 'handoff',
    actor: { agent: 'codex' },
    presetId: 'implement',
    instructions: 'Finish the work.',
    ...(reviewRepair ? { reviewRepair: true } : {})
  }
  render(
    <HandoffFields
      step={step}
      reviewRounds={reviewRounds}
      agents={[]}
      worktreeSelector={null}
      updateActor={vi.fn()}
      onChange={onChange}
    />
  )
  return onChange
}

it('leaves agent handoff unconditional until repair is explicitly selected', () => {
  const onChange = mount(3)
  const checkbox = screen.getByRole('checkbox', {
    name: 'Repair blocking findings between review rounds'
  })
  expect(checkbox.getAttribute('aria-checked')).toBe('false')
  fireEvent.click(checkbox)
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ reviewRepair: true }))
})

it('requires another review round before enabling a conditional repair', () => {
  mount(1)
  const checkbox = screen.getByRole('checkbox', {
    name: 'Repair blocking findings between review rounds'
  })
  expect(checkbox.hasAttribute('disabled')).toBe(true)
  expect(screen.getByText('Choose at least two review rounds to enable repair.')).toBeTruthy()
})

it('lets an owner turn off a saved repair after its review was removed or moved', () => {
  const onChange = mount(undefined, true)
  const checkbox = screen.getByRole('checkbox', {
    name: 'Repair blocking findings between review rounds'
  })
  expect(checkbox.hasAttribute('disabled')).toBe(false)
  expect(checkbox.getAttribute('aria-checked')).toBe('true')
  fireEvent.click(checkbox)
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ reviewRepair: false }))
})
