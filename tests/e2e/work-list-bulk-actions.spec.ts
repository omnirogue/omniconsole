import { test, expect } from './helpers/orca-app'
import { installBulkHandoffFixture } from './helpers/handoff-bulk-fixture'

test('quick archive preserves the selected detail and bulk completion reports a refused task', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  await electronApp.evaluate(({ ipcMain }) => {
    let items = ['Alpha', 'Beta', 'Gamma'].map((title, index) => ({
      task_id: `btk_fixture0${index}`,
      title,
      status: 'in_progress',
      state_revision: 3
    }))
    const register = (name: string, read: (...args: unknown[]) => unknown) => {
      ipcMain.removeHandler(name)
      ipcMain.handle(name, (_event, ...args) => read(...args))
    }
    register('backoffice:listTodo', () => ({
      ok: true,
      baseUrl: 'https://fixture.test',
      employeeId: 'emp_sal',
      generatedAt: null,
      items
    }))
    register('backoffice:archiveTask', (args) => {
      items = items.filter((item) => item.task_id !== (args as { taskId: string }).taskId)
      return { ok: true }
    })
    register('backoffice:completeTask', (args) => {
      const value = args as { taskId: string; expectedRevision: number }
      if (value.expectedRevision !== 3) {
        return { ok: false, message: 'Wrong revision' }
      }
      if (value.taskId === 'btk_fixture02') {
        return { ok: false, message: 'Evidence required' }
      }
      items = items.filter((item) => item.task_id !== value.taskId)
      return { ok: true }
    })
    register('consoleHandoffs:list', () => ({
      ok: true,
      data: { assignee: 'emp_sal', threads: [] }
    }))
    register('consoleHandoffs:recipients', () => ({
      ok: true,
      data: {
        peopleSource: 'directory',
        employees: [
          { id: 'emp_sal', name: 'Sal' },
          { id: 'emp_uma', name: 'Uma' }
        ]
      }
    }))
    register('consoleCompanies:me', () => ({
      ok: true,
      data: {
        ok: true,
        user: { employee_id: 'emp_sal', role: 'admin' },
        company_scope: 'all',
        companies: []
      }
    }))
  })
  await orcaPage.evaluate(() =>
    window.__store!.getState().openTaskPage({ taskSource: 'backoffice' })
  )
  await orcaPage
    .getByRole('navigation', { name: 'Work lenses' })
    .getByRole('button', { name: 'All', exact: true })
    .click()
  await expect(orcaPage.getByRole('checkbox', { name: 'Select all visible items' })).toBeVisible()
  await orcaPage.getByRole('button', { name: 'Archive Alpha', exact: true }).click()
  await expect(orcaPage.getByRole('checkbox', { name: 'Select Alpha', exact: true })).toHaveCount(0)
  await orcaPage.getByRole('checkbox', { name: 'Select all visible items' }).check()
  await orcaPage.getByRole('button', { name: 'Mark selected complete', exact: true }).click()
  await expect(
    orcaPage.getByRole('alert').filter({ hasText: 'Gamma: Evidence required' })
  ).toBeVisible()
  await expect(orcaPage.getByRole('checkbox', { name: 'Select Gamma', exact: true })).toBeChecked()
  await expect(orcaPage.getByRole('checkbox', { name: 'Select Beta', exact: true })).toHaveCount(0)
  await expect(
    orcaPage.getByRole('button', { name: 'Archive selected', exact: true })
  ).toBeEnabled()
  await orcaPage.screenshot({ path: testInfo.outputPath('bulk-partial-result.png') })
})

test('Work archives selected handoffs and restores them from a reopened archive', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  await installBulkHandoffFixture(electronApp)
  await orcaPage.evaluate(() =>
    window.__store!.getState().openTaskPage({ taskSource: 'backoffice' })
  )
  await expect(orcaPage.getByRole('checkbox', { name: 'Select Alpha handoff' })).toBeVisible()
  await orcaPage.getByRole('checkbox', { name: 'Select all visible items' }).check()
  await orcaPage.getByRole('button', { name: 'Archive selected', exact: true }).click()
  await expect(orcaPage.getByRole('checkbox', { name: 'Select Alpha handoff' })).toHaveCount(0)
  await expect(orcaPage.getByRole('checkbox', { name: 'Select Gamma handoff' })).toHaveCount(0)
  await orcaPage.getByRole('button', { name: 'Archived handoffs', exact: true }).click()
  let archive = orcaPage.getByRole('dialog', { name: 'Archived handoffs' })
  await expect(archive.getByRole('checkbox', { name: 'Select Alpha handoff' })).toBeVisible()
  await expect(archive.getByRole('checkbox', { name: 'Select Gamma handoff' })).toBeVisible()
  await archive.getByRole('button', { name: 'Close', exact: true }).click()
  await orcaPage.getByRole('button', { name: 'Archived handoffs', exact: true }).click()
  archive = orcaPage.getByRole('dialog', { name: 'Archived handoffs' })
  await archive.getByRole('checkbox', { name: 'Select all visible items' }).check()
  await orcaPage.screenshot({ path: testInfo.outputPath('handoffs-archive-restore.png') })
  await archive.getByRole('button', { name: 'Restore selected', exact: true }).click()
  await expect(archive.getByRole('checkbox', { name: 'Select Alpha handoff' })).toHaveCount(0)
  await expect(archive.getByRole('checkbox', { name: 'Select Gamma handoff' })).toHaveCount(0)
  await archive.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(orcaPage.getByRole('checkbox', { name: 'Select Alpha handoff' })).toBeVisible()
  await expect(orcaPage.getByRole('checkbox', { name: 'Select Gamma handoff' })).toBeVisible()
  await orcaPage
    .getByRole('button', { name: /^Waiting For/ })
    .first()
    .click()
  await orcaPage.getByRole('button', { name: 'Archive Beta handoff', exact: true }).click()
  await expect(orcaPage.getByRole('checkbox', { name: 'Select Beta handoff' })).toHaveCount(0)
})

test('Inbox selects handoffs and keeps unconfirmed completion selected', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  await installBulkHandoffFixture(electronApp)
  const work = orcaPage.locator('[data-nav-group="work"]')
  await expect(work).toBeVisible()
  if ((await work.getAttribute('aria-expanded')) !== 'true') {
    await work.click()
  }
  // The sidebar row reads "Inbox 2 unread" once the badge load lands (InboxSidebarEntry.tsx:18).
  await orcaPage.getByRole('button', { name: /^Inbox(?:\s|$)/ }).click()
  await orcaPage
    .getByRole('navigation', { name: 'Inbox sections' })
    .getByRole('button', { name: /^Handoff requests(?:\s|$)/ })
    .click()
  await expect(orcaPage.getByRole('checkbox', { name: 'Select Alpha handoff' })).toBeVisible()
  await orcaPage.getByRole('checkbox', { name: 'Select all visible items' }).check()
  await orcaPage.getByRole('button', { name: 'Mark selected complete', exact: true }).click()
  await expect(
    orcaPage.getByRole('alert').filter({ hasText: 'Gamma handoff: This handoff remains open.' })
  ).toBeVisible()
  await expect(orcaPage.getByRole('checkbox', { name: 'Select Gamma handoff' })).toBeChecked()
  await expect(orcaPage.getByRole('checkbox', { name: 'Select Alpha handoff' })).not.toBeChecked()
  // The Inbox list removes with delete, not archive (InboxRequests.tsx:171 -> BackofficeActionList.tsx:143).
  await expect(orcaPage.getByRole('button', { name: 'Delete selected', exact: true })).toBeEnabled()
  await orcaPage.screenshot({ path: testInfo.outputPath('inbox-handoff-partial-completion.png') })
})
