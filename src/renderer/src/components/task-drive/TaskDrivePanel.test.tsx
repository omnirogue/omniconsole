// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TaskDrivePanel } from './TaskDrivePanel'
import type {
  ConsoleCardDrive,
  ConsoleDriveApi,
  ConsoleDriveIntake
} from '../../../../shared/console-drive-contract'
import { readDriveRequest } from './drive-request-journal'

let accountScope = ''
let sequence = 0
vi.mock('@/components/handoffs/handoff-scope', () => ({ useHandoffScope: () => accountScope }))
vi.mock('@/components/next-step/use-handoff-people', () => ({
  useHandoffPeople: () => ({
    people: { phase: 'ready', value: [{ id: 'emp_sal', name: 'Sal' }] },
    reload: vi.fn()
  })
}))

const taskId = 'btk_test1234'
const folder: ConsoleCardDrive = {
  task_id: taskId,
  supports_project_intake_precondition: true,
  destination: {
    scope: 'project',
    scope_key: 'cgl_test',
    target: 'drive:cgl_test',
    display: 'Audit project'
  },
  declared: true,
  folder: {
    registry_id: 'drvf_test',
    folder_id: 'folder-test',
    link: 'https://drive.google.com/drive/folders/folder-test',
    status: 'active'
  }
}
const intake: ConsoleDriveIntake = {
  id: 'drin_created',
  task_id: taskId,
  expected_from: 'emp_sal',
  expected_from_email: 'sal@example.test',
  pattern: '*',
  expected_count: null,
  share_role: 'writer',
  created_by: 'sender@example.test',
  created_at: '2026-09-15T04:00:00Z',
  status: 'active',
  arrivals: 0,
  files: [],
  folder_link: folder.folder!.link
}
const api = {
  get: vi.fn<ConsoleDriveApi['get']>(),
  intakes: vi.fn<ConsoleDriveApi['intakes']>(),
  declare: vi.fn<ConsoleDriveApi['declare']>(),
  requestFiles: vi.fn<ConsoleDriveApi['requestFiles']>()
}

beforeEach(() => {
  vi.resetAllMocks()
  accountScope = `drive-test-${++sequence}`
  sessionStorage.clear()
  Object.defineProperty(window, 'api', { configurable: true, value: { consoleDrive: api } })
  api.get.mockResolvedValue({ ok: true, data: folder })
  api.intakes.mockResolvedValue({ ok: true, data: { task_id: taskId, intakes: [] } })
  api.declare.mockResolvedValue({ ok: true, data: folder })
  api.requestFiles.mockResolvedValue({ ok: true, data: intake })
})
afterEach(cleanup)

async function choosePerson() {
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Request files' }).hasAttribute('disabled')).toBe(
      false
    )
  )
  fireEvent.click(screen.getByRole('button', { name: 'Request files' }))
  fireEvent.click(screen.getByRole('combobox', { name: 'From' }))
  fireEvent.click(await screen.findByRole('option', { name: /Sal/ }))
}

it('names the real scope and links Google’s upload interface', async () => {
  render(<TaskDrivePanel taskId={taskId} />)
  const link = await screen.findByRole('link', { name: 'Open Drive folder' })
  expect(link.getAttribute('href')).toBe(folder.folder!.link)
  expect(screen.getByText('project folder · Audit project')).toBeTruthy()
  expect(screen.getByText(/Google handles upload progress and cancellation/)).toBeTruthy()
})

it('keeps a failed read distinct from no folder and never offers a write', async () => {
  api.get.mockResolvedValue({
    ok: false,
    error: { code: 'not_found', message: 'Drive is not served by this server.', status: 404 }
  })
  render(<TaskDrivePanel taskId={taskId} />)
  expect((await screen.findByRole('alert')).textContent).toContain('Drive is not served')
  expect(screen.queryByRole('button', { name: 'Create Drive folder' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Request files' })).toBeNull()
})

it('does not offer a writer grant on a company folder', async () => {
  api.get.mockResolvedValue({
    ok: true,
    data: { ...folder, destination: { ...folder.destination, scope: 'company' } }
  })
  render(<TaskDrivePanel taskId={taskId} />)
  expect(
    (await screen.findByRole('button', { name: 'Request files' })).hasAttribute('disabled')
  ).toBe(true)
  expect(screen.getByText(/This folder has company scope/)).toBeTruthy()
})

it('keeps older server folder links usable while file requests are unavailable', async () => {
  api.get.mockResolvedValue({
    ok: true,
    data: { ...folder, supports_project_intake_precondition: undefined }
  })
  render(<TaskDrivePanel taskId={taskId} />)
  expect(await screen.findByRole('link', { name: 'Open Drive folder' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Request files' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByText('File requests are not available on this server yet.')).toBeTruthy()
})

it('submits one exact recipient with truthful project permission copy and survives reopening while pending', async () => {
  let finish!: (value: Awaited<ReturnType<ConsoleDriveApi['requestFiles']>>) => void
  api.requestFiles.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  const view = render(<TaskDrivePanel taskId={taskId} />)
  await choosePerson()
  expect(screen.getByText(/writer access to the entire project folder/).textContent).toContain(
    'Audit project'
  )
  expect(screen.getByText(/That access remains/)).toBeTruthy()
  const submit = screen.getByRole('button', { name: 'Share folder and request files' })
  fireEvent.click(submit)
  fireEvent.click(submit)
  expect(api.requestFiles).toHaveBeenCalledTimes(1)
  expect(api.requestFiles).toHaveBeenCalledWith({
    taskId,
    expectedScopeKey: 'cgl_test',
    expected_from: 'emp_sal',
    pattern: '*'
  })
  view.unmount()
  render(<TaskDrivePanel taskId={taskId} />)
  expect(await screen.findByText('Sharing the folder and recording the file request…')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Request files' }).hasAttribute('disabled')).toBe(true)
  await act(async () => finish({ ok: true, data: intake }))
  expect(api.requestFiles).toHaveBeenCalledTimes(1)
  expect(readDriveRequest(`${accountScope}:${taskId}`)).toBeNull()
})

it('checks a lost response with GET and keeps the write blocked until the person checks records', async () => {
  api.requestFiles.mockResolvedValue({
    ok: false,
    error: { code: 'backoffice_unavailable', message: 'The response timed out.' }
  })
  render(<TaskDrivePanel taskId={taskId} />)
  await choosePerson()
  fireEvent.click(screen.getByRole('button', { name: 'Share folder and request files' }))
  expect(await screen.findByText(/last file request is uncertain/)).toBeTruthy()
  api.intakes.mockResolvedValue({ ok: true, data: { task_id: taskId, intakes: [intake] } })
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  expect(await screen.findByText(/matching request\(s\) appeared/)).toBeTruthy()
  expect(screen.getByText('sal@example.test · *')).toBeTruthy()
  expect(api.requestFiles).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('button', { name: 'Request files' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'I checked the requests' }))
  expect(api.requestFiles).toHaveBeenCalledTimes(1)
})

it('drops another account’s request state and ignores its late read', async () => {
  let finish!: (value: Awaited<ReturnType<ConsoleDriveApi['get']>>) => void
  api.get.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  const view = render(<TaskDrivePanel taskId={taskId} />)
  await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1))
  accountScope = `other-${sequence}`
  api.get.mockResolvedValue({
    ok: true,
    data: { ...folder, destination: { ...folder.destination, display: 'Other account project' } }
  })
  view.rerender(<TaskDrivePanel taskId={taskId} />)
  expect(await screen.findByText('project folder · Other account project')).toBeTruthy()
  await act(async () => finish({ ok: true, data: folder }))
  expect(screen.queryByText('project folder · Audit project')).toBeNull()
})

it('restores an interrupted request as uncertain and never retries it automatically', async () => {
  sessionStorage.setItem(
    `omni-drive-request:${accountScope}:${taskId}`,
    JSON.stringify({
      phase: 'pending',
      input: { taskId, expectedScopeKey: 'cgl_test', expected_from: 'emp_sal', pattern: '*' },
      beforeIds: []
    })
  )
  render(<TaskDrivePanel taskId={taskId} />)
  expect(await screen.findByText(/last file request is uncertain/)).toBeTruthy()
  expect(api.requestFiles).not.toHaveBeenCalled()
  expect(
    (await screen.findByRole('button', { name: 'Request files' })).hasAttribute('disabled')
  ).toBe(true)
})

it('keeps corrupt saved request state visible and blocks a duplicate write', async () => {
  sessionStorage.setItem(`omni-drive-request:${accountScope}:${taskId}`, '{broken')
  render(<TaskDrivePanel taskId={taskId} />)
  expect(await screen.findByText(/last file request is uncertain/)).toBeTruthy()
  expect(api.requestFiles).not.toHaveBeenCalled()
})
