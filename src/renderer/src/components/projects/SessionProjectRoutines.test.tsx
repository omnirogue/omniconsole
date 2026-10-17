// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Automation } from '../../../../shared/automations-types'

const runNow = vi.fn()
const open = vi.fn()
const setPendingRoutineDraftSeed = vi.fn()
const setActiveView = vi.fn()
const now = Date.now()
const routine = (id: string, sessionFolder?: string): Automation =>
  ({
    id,
    name: `Routine ${id}`,
    sessionFolder,
    enabled: true,
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    nextRunAt: now + 3_600_000
  }) as Automation

vi.mock('@/components/sidebar/routines/use-conversation-routines', () => ({
  useConversationRoutines: () => ({
    automations: [routine('a', 'folder-1'), routine('b', 'folder-2'), routine('c')],
    commands: { runNow },
    open
  })
}))
vi.mock('@/hooks/use-now', () => ({ useNow: () => now }))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ setPendingRoutineDraftSeed, setActiveView }) }
}))

import { SessionProjectRoutines } from './SessionProjectRoutines'

afterEach(cleanup)

it("lists only this project's routines, runs and opens them", () => {
  render(<SessionProjectRoutines folderId="folder-1" />)
  expect(screen.getByText('Routine a')).not.toBeNull()
  expect(screen.queryByText('Routine b')).toBeNull()
  expect(screen.queryByText('Routine c')).toBeNull()
  expect(screen.getByText(/Not run yet/)).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Run now' }))
  expect(runNow).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }))
  fireEvent.click(screen.getByText('Routine a'))
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }))
})

it('New routine opens the editor with the project as its folder', () => {
  render(<SessionProjectRoutines folderId="folder-2" />)
  fireEvent.click(screen.getByRole('button', { name: 'New routine' }))
  expect(setPendingRoutineDraftSeed).toHaveBeenCalledWith({
    cron: '0 9 * * *',
    sessionFolder: 'folder-2'
  })
  expect(setActiveView).toHaveBeenCalledWith('automations')
})
