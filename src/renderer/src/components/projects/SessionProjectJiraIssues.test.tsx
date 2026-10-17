// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { JiraSessionTask } from '../../../../shared/console-jira-session-contract'
import type { ConsoleJiraWorkRef } from '../../../../shared/console-jira-work-contract'
import { emptyProjectSettings, type ProjectSettings } from '../../../../shared/project-settings'

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  toastError: vi.fn(),
  dialog: null as null | {
    open: boolean
    onSelect: (task: JiraSessionTask) => Promise<boolean>
  }
}))
vi.mock('@/lib/session-organization-person-changes', () => ({
  setProjectSettingsByPerson: mocks.save
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/components/tasks/AttachToTaskDialog', () => ({
  AttachToTaskDialog: (props: {
    open: boolean
    onSelect: (task: JiraSessionTask) => Promise<boolean>
  }) => {
    mocks.dialog = props
    return null
  }
}))

import { SessionProjectJiraIssues } from './SessionProjectJiraIssues'

const FOLDER = '00000000-0000-4000-8000-000000000001'
const CLOUD = 'bb6f9191-a21a-4857-b965-32de82dce68b'
const ref = (id: number): ConsoleJiraWorkRef => ({
  provider: 'jira',
  cloud_id: CLOUD,
  issue_id: String(id),
  issue_key: `APU-${id}`,
  project_key: 'APU'
})
const settings = (tasks: ConsoleJiraWorkRef[]): ProjectSettings => ({
  ...emptyProjectSettings(1),
  tasks
})

beforeEach(() => {
  mocks.save.mockReset().mockReturnValue(true)
  mocks.toastError.mockReset()
  mocks.dialog = null
})
afterEach(cleanup)

it('adds a picked issue as one recorded project change', async () => {
  render(<SessionProjectJiraIssues folderId={FOLDER} settings={settings([ref(1)])} />)
  expect(screen.getByText('APU-1')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Add issue' }))
  expect(mocks.dialog?.open).toBe(true)
  let accepted = false
  await act(async () => {
    accepted = await mocks.dialog!.onSelect({ work_ref: ref(2) } as JiraSessionTask)
  })
  expect(accepted).toBe(true)
  expect(mocks.save).toHaveBeenCalledWith(FOLDER, settings([ref(1), ref(2)]))
})

it('closes on an issue already there without saving', async () => {
  render(<SessionProjectJiraIssues folderId={FOLDER} settings={settings([ref(1)])} />)
  await act(async () => {
    await mocks.dialog!.onSelect({ work_ref: ref(1) } as JiraSessionTask)
  })
  expect(mocks.save).not.toHaveBeenCalled()
})

it('removes an issue', () => {
  render(<SessionProjectJiraIssues folderId={FOLDER} settings={settings([ref(1), ref(2)])} />)
  fireEvent.click(screen.getByRole('button', { name: 'Remove APU-1 from this project' }))
  expect(mocks.save).toHaveBeenCalledWith(FOLDER, settings([ref(2)]))
})

it('stops offering Add issue at the project’s limit', () => {
  const full = Array.from({ length: 20 }, (_, index) => ref(index + 1))
  render(<SessionProjectJiraIssues folderId={FOLDER} settings={settings(full)} />)
  expect(screen.queryByRole('button', { name: 'Add issue' })).toBeNull()
})
