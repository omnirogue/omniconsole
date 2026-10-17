// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkPlanComposerBar } from './WorkPlanComposerBar'
import * as shapesModule from '../../../../shared/work-plan-shapes'
import * as commitModule from '../../../../shared/work-plan-commit'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
it('A0 delegates plain text without constructing or committing any plan', async () => {
  const nativeSend = vi.fn()
  const build = vi.spyOn(shapesModule, 'workPlanDraftFromShape')
  const commit = vi.spyOn(commitModule, 'commitWorkPlan')
  render(<WorkPlanComposerBar prompt="Hello" onNativeSend={nativeSend} />)
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() => expect(nativeSend).toHaveBeenCalledWith('Hello'))
  expect(build).not.toHaveBeenCalled()
  expect(commit).not.toHaveBeenCalled()
})
it('carries no Plan Mode, shape selector, Outcome or live chain (Sal, 2026-09-18)', () => {
  render(<WorkPlanComposerBar prompt="(plan) Hello" onNativeSend={vi.fn()} />)
  expect(screen.getByLabelText('Prompt')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()
  expect(screen.queryByText('Plan Mode')).toBeNull()
  expect(screen.queryByRole('checkbox')).toBeNull()
  expect(screen.queryByLabelText('Work shape')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Outcome' })).toBeNull()
  expect(screen.queryByLabelText('Outcome title')).toBeNull()
  expect(screen.queryByLabelText('Live chain')).toBeNull()
  expect(document.querySelector('[data-shape]')).toBeNull()
  expect(screen.getAllByRole('button')).toHaveLength(1)
})
it('sends a typed `(plan)` token as ordinary text and clears its own draft after a send', async () => {
  const nativeSend = vi.fn(() => true)
  render(<WorkPlanComposerBar onNativeSend={nativeSend} />)
  const prompt = screen.getByLabelText('Prompt') as HTMLInputElement
  fireEvent.change(prompt, { target: { value: '(plan) Ship it' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() => expect(nativeSend).toHaveBeenCalledWith('(plan) Ship it'))
  await waitFor(() => expect(prompt.value).toBe(''))
})
it('keeps the draft when the surface refuses the send, and says why when it throws', async () => {
  const refused = vi.fn(() => false)
  const first = render(<WorkPlanComposerBar onNativeSend={refused} />)
  const prompt = screen.getByLabelText('Prompt') as HTMLInputElement
  fireEvent.change(prompt, { target: { value: 'Hello' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() => expect(refused).toHaveBeenCalledWith('Hello'))
  expect(prompt.value).toBe('Hello')
  expect(screen.queryByRole('alert')).toBeNull()
  first.unmount()
  const throwing = vi.fn(() => {
    throw new Error('No agent is ready.')
  })
  render(<WorkPlanComposerBar prompt="Hello" onNativeSend={throwing} />)
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('No agent is ready.'))
})
it('does nothing while disabled', () => {
  const nativeSend = vi.fn()
  render(<WorkPlanComposerBar prompt="Hello" disabled onNativeSend={nativeSend} />)
  const send = screen.getByRole('button', { name: 'Send' })
  expect(send.hasAttribute('disabled')).toBe(true)
  fireEvent.click(send)
  expect(nativeSend).not.toHaveBeenCalled()
})
it('is one row: a one-line field that grows to six, with Send inline at its right', () => {
  render(<WorkPlanComposerBar onNativeSend={vi.fn()} />)
  const prompt = screen.getByLabelText('Prompt') as HTMLTextAreaElement
  expect(prompt.tagName).toBe('TEXTAREA')
  expect(prompt.getAttribute('rows')).toBe('1')
  expect(prompt.className).toContain('[field-sizing:content]')
  expect(prompt.className).toContain('max-h-[calc(6lh_+_1rem)]')
  expect(prompt.className).toContain('flex-1')
  expect(prompt.getAttribute('placeholder')).toBe(
    'Prompt · Enter to send, Shift+Enter for a new line'
  )
  const send = screen.getByRole('button', { name: 'Send' })
  expect(send.getAttribute('data-size')).toBe('sm')
  expect(send.className).toContain('shrink-0')
  // Same flex row, field first then Send: nothing wraps Send onto a line of its own.
  expect(prompt.parentElement).toBe(send.parentElement)
  expect(prompt.parentElement!.className).toContain('flex')
  expect(prompt.parentElement!.className).not.toContain('flex-wrap')
  expect(prompt.nextElementSibling).toBe(send)
})
it('Enter sends and clears; Shift+Enter only breaks the line', async () => {
  const nativeSend = vi.fn(() => true)
  render(<WorkPlanComposerBar onNativeSend={nativeSend} />)
  const prompt = screen.getByLabelText('Prompt') as HTMLTextAreaElement
  fireEvent.change(prompt, { target: { value: 'First line' } })
  const shiftEnter = fireEvent.keyDown(prompt, { key: 'Enter', shiftKey: true })
  // Not prevented: the browser inserts the newline itself.
  expect(shiftEnter).toBe(true)
  expect(nativeSend).not.toHaveBeenCalled()
  fireEvent.change(prompt, { target: { value: 'First line\nSecond line' } })
  const enter = fireEvent.keyDown(prompt, { key: 'Enter' })
  expect(enter).toBe(false)
  await waitFor(() => expect(nativeSend).toHaveBeenCalledWith('First line\nSecond line'))
  await waitFor(() => expect(prompt.value).toBe(''))
  expect(nativeSend).toHaveBeenCalledTimes(1)
})
it('Enter while disabled sends nothing', () => {
  const nativeSend = vi.fn()
  render(<WorkPlanComposerBar prompt="Hello" disabled onNativeSend={nativeSend} />)
  fireEvent.keyDown(screen.getByLabelText('Prompt'), { key: 'Enter' })
  expect(nativeSend).not.toHaveBeenCalled()
})
