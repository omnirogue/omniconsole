import { test, expect } from './helpers/orca-app'

test('opens a task Drive folder and records one explicit file request', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  await electronApp.evaluate(({ ipcMain }) => {
    const taskId = 'btk_drive_fixture'
    const destination = {
      scope: 'project',
      scope_key: 'project:drive_fixture',
      display: 'Drive UI test',
      target: 'drive:project'
    }
    const folder = {
      registry_id: 'drvf_fixture',
      folder_id: 'fixture_folder',
      link: 'https://drive.google.com/drive/folders/fixture_folder',
      status: 'active'
    }
    let declared = false
    const intakes: unknown[] = []
    const requests: unknown[] = []
    Object.defineProperty(globalThis, '__driveFixtureRequests', { value: requests })
    const register = (name: string, fn: (...args: unknown[]) => unknown) => {
      ipcMain.removeHandler(name)
      ipcMain.handle(name, (_event, ...args) => fn(...args))
    }
    const drive = () => ({
      ok: true,
      data: {
        task_id: taskId,
        destination,
        declared,
        folder: declared ? folder : null,
        supports_project_intake_precondition: true
      }
    })
    register('backoffice:listTodo', () => ({
      ok: true,
      baseUrl: 'https://fixture.test',
      employeeId: 'emp_sender',
      generatedAt: null,
      items: [{ task_id: taskId, title: 'Drive transfer test', status: 'in_progress' }]
    }))
    register('consoleCompanies:me', () => ({
      ok: true,
      data: {
        ok: true,
        user: { employee_id: 'emp_sender', role: 'admin' },
        company_scope: 'all',
        companies: []
      }
    }))
    register('consoleCompanies:folders', () => ({ ok: true, data: { folders: [] } }))
    register('consoleHandoffs:list', () => ({
      ok: true,
      data: { assignee: 'emp_sender', threads: [] }
    }))
    register('consoleHandoffs:taskFiles', () => ({ ok: true, data: { files: [] } }))
    register('consoleHandoffs:recipients', () => ({
      ok: true,
      data: { employees: [{ id: 'emp_recipient', name: 'Transfer test recipient' }] }
    }))
    register('consoleDrive:get', drive)
    register('consoleDrive:declare', () => {
      declared = true
      return drive()
    })
    register('consoleDrive:intakes', () => ({ ok: true, data: { task_id: taskId, intakes } }))
    register('consoleDrive:requestFiles', async (input) => {
      requests.push(input)
      await new Promise((resolve) => setTimeout(resolve, 200))
      const row = {
        id: 'drin_fixture',
        task_id: taskId,
        expected_from: 'emp_recipient',
        expected_from_email: 'recipient@example.test',
        pattern: '*.mp4',
        expected_count: 1,
        share_role: 'writer',
        status: 'fulfilled',
        arrivals: 1,
        created_by: 'emp_sender',
        created_at: '2026-09-15T04:00:00Z',
        folder_link: folder.link,
        destination,
        files: [
          {
            file_id: 'fixture_video',
            name: 'drive-ui-fixture.mp4',
            size_bytes: 499532353,
            link: 'https://drive.google.com/file/d/fixture_video/view',
            sender_id: 'emp_recipient',
            sender_email: 'recipient@example.test',
            disposition: 'received',
            first_seen_at: '2026-09-15T04:01:00Z'
          }
        ]
      }
      intakes.push(row)
      return { ok: true, data: row }
    })
  })
  await orcaPage.evaluate(() => {
    window.__store!.getState().openTaskPage({ taskSource: 'backoffice' })
  })
  await orcaPage.getByRole('button', { name: 'All', exact: true }).click()
  await orcaPage.locator('[data-work-row="todo:btk_drive_fixture:::task"]').click()
  await orcaPage.getByText('Files and evidence', { exact: true }).click()
  const panel = orcaPage.getByRole('region', { name: 'Google Drive', exact: true })
  await expect(panel).toContainText('project folder · Drive UI test')
  await panel.getByRole('button', { name: 'Create Drive folder', exact: true }).click()
  await expect(panel.getByRole('link', { name: 'Open Drive folder' })).toHaveAttribute(
    'href',
    'https://drive.google.com/drive/folders/fixture_folder'
  )
  await panel.getByRole('button', { name: 'Request files', exact: true }).click()
  await panel.getByRole('combobox', { name: 'From', exact: true }).click()
  await orcaPage.getByRole('option', { name: /Transfer test recipient/ }).click()
  await expect(orcaPage.getByRole('option', { name: /Transfer test recipient/ })).toHaveCount(0)
  await panel.getByLabel('File names', { exact: true }).fill('*.mp4')
  await panel.getByLabel('Number of files', { exact: true }).fill('1')
  await expect(panel).toContainText(
    'Transfer test recipient gets writer access to the entire project folder, Drive UI test.'
  )
  await panel.screenshot({ path: testInfo.outputPath('drive-request-form.png') })
  await panel.getByRole('button', { name: 'Share folder and request files', exact: true }).click()
  await expect(panel.getByRole('button', { name: 'Request files', exact: true })).toBeDisabled()
  await expect(panel).toContainText('File request recorded for recipient@example.test.')
  await expect(panel).toContainText('499,532,353 bytes · received')
  await expect(panel.getByRole('link', { name: 'drive-ui-fixture.mp4' })).toHaveAttribute(
    'href',
    'https://drive.google.com/file/d/fixture_video/view'
  )
  expect(
    await electronApp.evaluate(() => Reflect.get(globalThis, '__driveFixtureRequests'))
  ).toEqual([
    {
      taskId: 'btk_drive_fixture',
      expectedScopeKey: 'project:drive_fixture',
      expected_from: 'emp_recipient',
      pattern: '*.mp4',
      expected_count: 1
    }
  ])
  await panel.screenshot({ path: testInfo.outputPath('drive-request-received.png') })
})
