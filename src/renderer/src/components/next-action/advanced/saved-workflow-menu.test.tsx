// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  SavedWorkflowMenu,
  type SavedWorkflow,
  type SavedWorkflowSource
} from './saved-workflow-menu'

afterEach(cleanup)
const stage = {
  kind: 'agent' as const,
  template: 'improve' as const,
  n: 3,
  shape: 'parallel' as const,
  instruction: 'Review this',
  advanced: { model: 'chosen', readsFrom: [], endOnSuccess: false }
}

it('lists, applies only a stage patch, saves current configuration, renames and deletes', async () => {
  let entries: SavedWorkflow[] = [{ id: 'one', name: 'Original', executable: true, stage }]
  const source: SavedWorkflowSource = {
    list: vi.fn(async () => structuredClone(entries)),
    save: vi.fn(async (entry) => {
      entries.push({ ...entry, id: 'two' })
    }),
    rename: vi.fn(async (id, name) => {
      entries = entries.map((entry) => (entry.id === id ? { ...entry, name } : entry))
    }),
    delete: vi.fn(async (id) => {
      entries = entries.filter((entry) => entry.id !== id)
    })
  }
  const onUse = vi.fn()
  render(<SavedWorkflowMenu stage={stage} disabled={false} onUse={onUse} source={source} />)
  fireEvent.click(await screen.findByText('Original'))
  expect(onUse).toHaveBeenCalledWith(stage)
  expect(onUse.mock.calls[0]?.[0]).not.toHaveProperty('id')
  fireEvent.change(screen.getByLabelText('Save this stage as…'), { target: { value: 'Current' } })
  fireEvent.click(screen.getByText('Save stage'))
  await screen.findByText('Current')
  expect(source.save).toHaveBeenCalledWith(expect.objectContaining({ name: 'Current', stage }))
  fireEvent.click(screen.getAllByText('Rename')[0]!)
  fireEvent.change(screen.getByLabelText('New workflow name'), { target: { value: 'Renamed' } })
  fireEvent.click(screen.getByText('Save name'))
  await screen.findByText('Renamed')
  fireEvent.click(screen.getAllByText('Delete')[0]!)
  await waitFor(() => expect(screen.queryByText('Renamed')).toBeNull())
  expect(source.list).toHaveBeenCalledTimes(4)
})

it('waits for the authoritative refresh without inventing a saved row', async () => {
  let finish!: (entries: SavedWorkflow[]) => void
  const source: SavedWorkflowSource = {
    list: vi
      .fn()
      .mockResolvedValueOnce([])
      .mockImplementationOnce(
        () =>
          new Promise<SavedWorkflow[]>((resolve) => {
            finish = resolve
          })
      ),
    save: vi.fn(async () => {})
  }
  render(<SavedWorkflowMenu stage={stage} disabled={false} onUse={vi.fn()} source={source} />)
  await screen.findByText('No saved workflows yet.')
  expect(screen.getByText(/contain one agent stage/)).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Save this stage as…'), { target: { value: 'Pending' } })
  fireEvent.click(screen.getByText('Save stage'))
  await waitFor(() => expect(source.list).toHaveBeenCalledTimes(2))
  expect(screen.queryByRole('button', { name: 'Pending' })).toBeNull()
  finish([])
  await waitFor(() => expect(screen.getByRole('group').getAttribute('aria-busy')).toBe('false'))
  expect(screen.queryByRole('button', { name: 'Pending' })).toBeNull()
})

it('reports a failed initial read rather than an empty profile', async () => {
  const source: SavedWorkflowSource = {
    list: vi.fn(async () => {
      throw new Error('offline')
    }),
    save: vi.fn()
  }
  render(<SavedWorkflowMenu stage={stage} disabled={false} onUse={vi.fn()} source={source} />)
  await screen.findByRole('alert')
  expect(screen.queryByText('No saved workflows yet.')).toBeNull()
})
