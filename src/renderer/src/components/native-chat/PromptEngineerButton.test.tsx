// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { PromptEngineerButton } from './PromptEngineerButton'
import { PromptEngineerStatus } from './PromptEngineerStatus'
import { usePromptEngineer } from './use-prompt-engineer'
import { TooltipProvider } from '@/components/ui/tooltip'

afterEach(cleanup)
function Harness({
  paneKey,
  deliver,
  working = false
}: {
  paneKey: string
  deliver: (text: string) => boolean | Promise<boolean>
  working?: boolean
}) {
  const engineer = usePromptEngineer(paneKey)
  return (
    <TooltipProvider>
      <PromptEngineerButton
        active={engineer.active}
        disabled={working}
        onToggle={engineer.toggle}
      />
      {engineer.active ? (
        <PromptEngineerStatus
          disabled={working || !engineer.canGo}
          onGo={() => void engineer.send('', deliver, true)}
        />
      ) : null}
      <button onClick={() => void engineer.send('Build a page for students', deliver)}>Send</button>
    </TooltipProvider>
  )
}
it('refines and executes through one transport without opening a dialog', async () => {
  const deliver = vi.fn(() => true)
  const { rerender } = render(<Harness paneKey="wizard-flow" deliver={deliver} />)
  fireEvent.click(screen.getByRole('button', { name: 'Prompt Engineer' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(deliver).not.toHaveBeenCalled()
  expect((screen.getByRole('button', { name: 'Go' }) as HTMLButtonElement).disabled).toBe(true)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send' })))
  expect(deliver).toHaveBeenLastCalledWith(expect.stringContaining('do not execute the task'))
  expect(deliver).toHaveBeenLastCalledWith(expect.stringContaining('Build a page for students'))
  rerender(<Harness paneKey="wizard-flow" deliver={deliver} working />)
  expect((screen.getByRole('button', { name: 'Go' }) as HTMLButtonElement).disabled).toBe(true)
  rerender(<Harness paneKey="wizard-flow" deliver={deliver} />)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Go' })))
  expect(deliver).toHaveBeenLastCalledWith(
    expect.stringContaining('carry out the latest revised prompt in this conversation')
  )
  expect(screen.queryByRole('button', { name: 'Go' })).toBeNull()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send' })))
  expect(deliver).toHaveBeenLastCalledWith('Build a page for students')
})
it('keeps refinement mode on refusal and suppresses duplicate in-flight sends', async () => {
  let resolve!: (accepted: boolean) => void
  const deliver = vi.fn(
    () =>
      new Promise<boolean>((done) => {
        resolve = done
      })
  )
  render(<Harness paneKey="wizard-refusal" deliver={deliver} />)
  fireEvent.click(screen.getByRole('button', { name: 'Prompt Engineer' }))
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  expect(deliver).toHaveBeenCalledTimes(1)
  await act(async () => resolve(false))
  expect((screen.getByRole('button', { name: 'Go' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await act(async () => resolve(true))
  fireEvent.click(screen.getByRole('button', { name: 'Go' }))
  await act(async () => resolve(false))
  expect(screen.getByRole('button', { name: 'Go' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Prompt Engineer' }).getAttribute('aria-pressed')).toBe(
    'true'
  )
})
it('restores refinement mode after remounting the same pane and isolates other panes', async () => {
  const deliver = vi.fn(() => true)
  const view = render(<Harness paneKey="wizard-restore" deliver={deliver} />)
  fireEvent.click(screen.getByRole('button', { name: 'Prompt Engineer' }))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send' })))
  view.unmount()
  const restored = render(<Harness paneKey="wizard-restore" deliver={deliver} />)
  expect((screen.getByRole('button', { name: 'Go' }) as HTMLButtonElement).disabled).toBe(false)
  restored.unmount()
  render(<Harness paneKey="wizard-other" deliver={deliver} />)
  expect(screen.queryByRole('button', { name: 'Go' })).toBeNull()
})
