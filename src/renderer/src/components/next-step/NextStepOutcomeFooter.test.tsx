// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NextStepOutcomeFooter } from './NextStepOutcomeFooter'
import type { NextStepPrimaryAction } from './next-step-outcome-primary-action'

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replace(`{{${key}}}`, String(value)),
      fallback
    )
}))
afterEach(cleanup)

const ready = { durableContinuation: true as const, reason: undefined }

function primary(
  action: NextStepPrimaryAction,
  patch: Partial<Parameters<typeof NextStepOutcomeFooter>[0]> = {}
): HTMLButtonElement {
  render(
    <NextStepOutcomeFooter
      pending={false}
      timing="done"
      capabilities={ready as never}
      hasAgent
      action={action}
      onHide={() => {}}
      onSave={() => {}}
      {...patch}
    />
  )
  return screen.getAllByRole('button').at(-1) as HTMLButtonElement
}

it('says what will happen', () => {
  expect(primary({ kind: 'save' }).textContent).toBe('Save & hide')
  cleanup()
  expect(primary({ kind: 'start', count: 1 }).textContent).toBe('Start 1 step')
  cleanup()
  expect(primary({ kind: 'start', count: 2 }).textContent).toBe('Start 2 steps')
  cleanup()
  expect(primary({ kind: 'send', name: 'Uma' }).textContent).toBe('Send to Uma')
  cleanup()
  expect(primary({ kind: 'handoff', name: 'Uma' }).textContent).toBe('Hand off to Uma')
})

it('waits for a teammate, and keeps the host gate with its reason', () => {
  const choose = primary({ kind: 'choose-teammate' })
  expect(choose.textContent).toBe('Choose a teammate')
  expect(choose.disabled).toBe(true)
  cleanup()
  const gated = primary(
    { kind: 'save' },
    { capabilities: { durableContinuation: false, reason: 'Host is offline.' } as never }
  )
  expect(gated.disabled).toBe(true)
  expect(screen.getByText('Host is offline.')).toBeTruthy()
  cleanup()
  const sending = primary({ kind: 'handoff', name: 'Uma' }, { timing: 'now', capabilities: null })
  expect(sending.disabled).toBe(false)
  cleanup()
  expect(primary({ kind: 'save' }, { pending: true }).textContent).toBe('Saving…')
})
