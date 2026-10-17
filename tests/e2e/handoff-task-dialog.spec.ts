import { test, expect } from './helpers/orca-app'

test('adds the next person from the card and reviews an exact file version on its thread', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  await electronApp.evaluate(({ ipcMain }) => {
    const thread = {
      id: 'hth_fixture',
      board_task_id: 'btk_fixture01',
      author_employee_id: 'emp_one',
      recipient_employee_id: 'emp_two',
      title: 'Proposal review',
      state: 'open',
      action: 'review',
      due_at: null,
      parent_thread_id: null,
      delivery_id: 'delivery_fixture',
      updated: '2026-09-10T21:00:00Z'
    }
    const file = {
      id: 'hfv_fixture',
      path: 'uploads/proposal.docx',
      name: 'proposal.docx',
      sha256: 'a'.repeat(64),
      size: 2048,
      version: 1,
      parent_version_id: null,
      current: true,
      available: true
    }
    const detail = {
      thread,
      files: [file],
      reviews: [] as unknown[],
      entries: [
        {
          id: 'entry_fixture',
          kind: 'handoff',
          body: 'Please review the proposal.',
          created: '2026-09-10T21:00:00Z'
        }
      ]
    }
    const register = (name: string, fn: (...args: unknown[]) => unknown) => {
      ipcMain.removeHandler(name)
      ipcMain.handle(name, (_event, ...args) => fn(...args))
    }
    register('backoffice:listTodo', () => ({
      ok: true,
      baseUrl: 'https://fixture.test',
      employeeId: 'emp_two',
      generatedAt: null,
      items: [
        {
          task_id: thread.board_task_id,
          title: thread.title,
          company_slug: 'example',
          status: 'in_progress',
          state_revision: 1,
          primary_action: { handoff_thread_id: thread.id }
        }
      ]
    }))
    register('consoleHandoffs:recipients', () => ({
      ok: true,
      data: { employees: [{ id: 'emp_two', name: 'Review teammate' }] }
    }))
    register('consoleCompanies:me', () => ({
      ok: true,
      data: {
        ok: true,
        user: { employee_id: 'emp_one', role: 'admin' },
        company_scope: 'all',
        companies: []
      }
    }))
    register('consoleCompanies:folders', () => ({ ok: true, data: { folders: [] } }))
    register('consoleHandoffs:taskFiles', () => ({
      ok: true,
      data: { files: [{ rel: file.path, size: file.size, sha256: file.sha256 }] }
    }))
    register('consoleHandoffs:send', (input) => {
      const request = input as { fileVersions: { path: string; sha256: string }[] }
      if (request.fileVersions[0]?.sha256 !== file.sha256) {
        return { ok: false, error: { code: 'wrong_version', message: 'Select the exact version.' } }
      }
      return { ok: true, data: { thread_id: thread.id } }
    })
    register('consoleHandoffs:list', () => ({
      ok: true,
      data: {
        assignee: 'emp_two',
        threads: [{ ...thread, files: [file], reviews: detail.reviews }]
      }
    }))
    for (const name of ['get', 'markRead']) {
      register(`consoleHandoffs:${name}`, () => ({ ok: true, data: detail }))
    }
    register('consoleHandoffs:review', (input) => {
      const request = input as { versionIds: string[] }
      if (request.versionIds.join(',') !== file.id) {
        return {
          ok: false,
          error: {
            code: 'file_version_changed',
            status: 409,
            message: 'Review the current versions.'
          }
        }
      }
      detail.reviews = [
        { id: 'review_fixture', decision: 'approve', version_ids: [file.id], current: true }
      ]
      return { ok: true, data: { thread_id: thread.id } }
    })
  })
  await orcaPage.evaluate(() => {
    window.__store!.getState().openTaskPage({ taskSource: 'backoffice' })
  })
  // Why: Needs You lists the task and the review thread on it as separate obligations.
  const taskKey = 'todo:btk_fixture01:::task'
  const taskRow = orcaPage.locator(`[data-work-row="${taskKey}"]`)
  await expect(taskRow).toContainText('Proposal review')
  await taskRow.click()
  await expect(
    orcaPage.getByRole('button', { name: 'Complete', exact: true }).first()
  ).toBeVisible()
  // The card's Up next sits open in its detail, beside Complete: there is no ＋ to press first.
  const panel = orcaPage.locator(`[data-work-detail="${taskKey}"] [data-up-next-chain]`)
  await panel.getByRole('button', { name: '+ Person', exact: true }).click()
  await panel
    .getByRole('group', { name: 'To', exact: true })
    .getByRole('button', { name: 'Review teammate', exact: true })
    .click()
  await expect(panel.locator('[data-up-next-row]')).toContainText('Review teammate')
  await expect(
    panel.getByRole('button', { name: 'Remove Review teammate', exact: true })
  ).toBeVisible()
  // The note is on the form itself: every send carries the files, summary and conversation.
  await panel.getByLabel('Note', { exact: true }).fill('Please review the proposal.')
  await panel.getByLabel('Note', { exact: true }).blur()
  await orcaPage.screenshot({ path: testInfo.outputPath('send-task.png') })
  // A lone send is committed by its own verb. Why not pressed: a card's commit first launches the
  // card's own agent session (task continuation), and this fixture configures no agent to launch.
  await expect(panel.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
  // Why: the review thread on the same card opens beside it; ✓ and the file review live there.
  await expect(orcaPage.getByText('proposal.docx', { exact: true }).first()).toBeVisible()
  // Looks good approves exactly the current file versions; the fixture refuses any other set.
  await orcaPage.getByRole('button', { name: 'Looks good, continue', exact: true }).click()
  await expect(orcaPage.getByText('You said: looks good', { exact: true })).toBeVisible()
  await orcaPage.screenshot({ path: testInfo.outputPath('reviewed-task.png') })
  await taskRow.click()
  await expect(
    orcaPage.getByRole('button', { name: 'Complete', exact: true }).first()
  ).toBeVisible()
  await expect(orcaPage.getByRole('dialog')).toHaveCount(0)
  await expect(taskRow).toContainText('Proposal review')
})
