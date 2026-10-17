/** @vitest-environment happy-dom */
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { DropdownMenu, DropdownMenuContent } from '@/components/ui/dropdown-menu'
import { OmpLaunchModels } from './OmpLaunchModels'

vi.mock('@/store', () => ({
  useAppStore: (select: (state: unknown) => unknown) => select({ settings: {} })
}))
vi.mock('@/lib/workflow-model-client', () => ({
  workflowModelClient: {
    models: async () => ({
      models: [
        { id: 'moonshotai/kimi-k3', name: 'Kimi K3', tools: true },
        { id: 'openai/gpt-5.5', name: 'GPT 5.5', tools: true },
        { id: 'new-author/text-only', name: 'Text only', tools: false }
      ]
    })
  }
}))
afterEach(cleanup)

it('browses all families and selects before launching an exact model', async () => {
  const start = vi.fn()
  render(
    <DropdownMenu open>
      <DropdownMenuContent>
        <OmpLaunchModels start={start} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Launch selected model' })).not.toBeDisabled()
  )
  expect(start).not.toHaveBeenCalled()
  expect(screen.getByText('new-author')).toBeVisible()
  expect(screen.getByRole('menuitem', { name: /Text only/ })).toHaveAttribute('data-disabled')
  fireEvent.click(screen.getByRole('button', { name: 'Launch selected model' }))
  expect(start).toHaveBeenLastCalledWith({ agent: 'omp', customModelId: 'moonshotai/kimi-k3' })
  start.mockClear()
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'GPT' } })
  expect(screen.queryByRole('menuitem', { name: /Kimi/ })).toBeNull()
  fireEvent.click(screen.getByRole('menuitem', { name: /GPT 5.5/ }))
  expect(start).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Launch selected model' }))
  expect(start).toHaveBeenCalledWith({ agent: 'omp', customModelId: 'openai/gpt-5.5' })
})
