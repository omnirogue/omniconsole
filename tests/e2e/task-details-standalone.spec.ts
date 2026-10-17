import { writeFileSync } from 'node:fs'
import { test, expect } from './helpers/orca-app'

test.use({ seedTestRepo: false })

// Obsolete since 63ff9494da (2026-09-19, "fix(tasks): redirect retired hub creation controls to
// Jira"). CreateTaskDialog.tsx no longer holds a task form at all: it renders "Tasks now live in
// Jira" plus Cancel / "Open Jira tasks", which calls shell.openUrl('<console>/work/jira'). The
// board button reads "New Jira task" (NewTaskButton.tsx:30), and createTaskFromUi
// (create-task-submit.ts:51) has no caller left in src/, so there is no in-app path that creates a
// standalone parent for this spec to drive. Editing a saved parent is still covered by
// work-kanban-lifecycle.spec.ts:255-278 and TaskDetailsEditor.test.tsx. Prefer deleting this file;
// this skip is the reversible form if a breadcrumb is wanted until the Jira capture flow gets its
// own e2e.
test.skip(true, 'Hub task creation was retired and redirects to Jira (63ff9494da).')

test('an empty personal Kanban creates and edits one standalone parent without starting sessions', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  await electronApp.evaluate(({ ipcMain }) => {
    const ok = (data: unknown) => ({ ok: true, data })
    const register = (name: string, read: (args: unknown) => unknown) => {
      ipcMain.removeHandler(name)
      ipcMain.handle(name, (_event, args) => read(args))
    }
    const companies = [
      {
        id: 'co_omnirogue',
        slug: 'omnirogue',
        name: 'OmniRogue',
        domains: [{ id: 'org_development', name: 'Development', projects: [] }]
      }
    ]
    const evidence = { created: 0, sessions: 0, uploads: 0, edits: 0 }
    ;(
      globalThis as typeof globalThis & { __standaloneTaskEvidence: unknown }
    ).__standaloneTaskEvidence = evidence
    let task: Record<string, unknown> | null = null
    register('consoleCompanies:me', () =>
      ok({ ok: true, user: { employee_id: 'emp_sal', role: 'member' }, companies })
    )
    register('consoleCompanies:folders', () => ok({ ok: true, companies }))
    register('backoffice:listTodo', () => ({
      ok: true,
      baseUrl: 'https://fixture.test',
      employeeId: 'emp_sal',
      items: [],
      awaitingVerification: [],
      generatedAt: null,
      nextCursor: null
    }))
    register('backoffice:feed', () => ({
      ok: true,
      body: { projects: [], people: [], threads: [] }
    }))
    register('consoleHandoffs:recipients', () =>
      ok({ employees: [{ id: 'emp_sal', name: 'Sal' }] })
    )
    register('consoleHandoffs:list', () => ok({ assignee: 'emp_sal', threads: [] }))
    register('consoleWorkflows:listHumanActions', () => ok({ jobs: [] }))
    register('consoleWorkflows:listWork', () =>
      ok({ items: task ? [task] : [], total: task ? 1 : 0, capped: false, companies })
    )
    register('consoleWorkflows:getTask', (args) => {
      const { taskId } = args as { taskId: string }
      if (!task || taskId !== task.id) {
        throw new Error('Read the exact created parent.')
      }
      return ok({ ...task, publicationPrincipal: 'a'.repeat(64) })
    })
    register('consoleWorkflows:getTaskLifecycle', () => ok({ task: { id: task?.id } }))
    register('consoleWorkflows:listTaskActivity', () => ok([]))
    register('consoleWorkflows:listWorkSessions', () => ok({ sessions: [] }))
    register('consoleWorkflows:taskSessions', () => ok({ sessions: [] }))
    register('consoleHandoffs:taskFiles', () => ok({ files: [] }))
    for (const method of ['ingestSession', 'attachSession', 'admitTask', 'admitWorkflow']) {
      register(`consoleWorkflows:${method}`, () => {
        evidence.sessions += 1
        throw new Error('Standalone task creation must not start or invent a session.')
      })
    }
    register('backoffice:createTask', (args) => {
      const input = args as {
        title: string
        description: string
        ownerEmployeeId: string
        companyId: string
        unitId: string
        dueDate: string
        priority: string
        sequentialSteps: string[]
      }
      if (
        task ||
        input.ownerEmployeeId !== 'emp_sal' ||
        input.companyId !== 'co_omnirogue' ||
        input.unitId !== 'org_development' ||
        input.title !== 'Deliver the launch plan' ||
        input.description !== 'Shared context before any session exists' ||
        input.dueDate !== '2026-09-30' ||
        input.priority !== 'high' ||
        JSON.stringify(input.sequentialSteps) !==
          JSON.stringify(['AI drafts the launch plan', 'Sal reviews the result'])
      ) {
        throw new Error('Create one filed parent with the exact form values.')
      }
      evidence.created += 1
      task = {
        id: 'btk_standalone',
        title: input.title,
        description: input.description,
        owner_employee_id: input.ownerEmployeeId,
        company_slug: 'omnirogue',
        org_company_id: input.companyId,
        org_unit_id: input.unitId,
        due_date: input.dueDate,
        priority: input.priority,
        sequential_steps: input.sequentialSteps,
        source: 'omniconsole-ide',
        kanban_eligible: true,
        triage_state: 'filed',
        status: 'open',
        kanban_status: 'ready',
        state_revision: 1
      }
      return { ok: true, taskId: task.id, title: task.title, principal: 'a'.repeat(64) }
    })
    register('consoleHandoffs:uploadFile', (args) => {
      const input = args as {
        taskId: string
        purpose: string
        expectedPrincipal: string
        file: { name: string; contentBase64: string; sha256: string }
      }
      if (
        input.taskId !== task?.id ||
        input.purpose !== 'task' ||
        input.expectedPrincipal !== 'a'.repeat(64) ||
        input.file.name !== 'launch-reference.txt' ||
        Buffer.from(input.file.contentBase64, 'base64').toString() !== 'Launch reference'
      ) {
        throw new Error('Attach the selected bytes to the existing parent.')
      }
      evidence.uploads += 1
      return ok({ path: 'uploads/launch-reference.txt', sha256: input.file.sha256 })
    })
    register('consoleWorkflows:updateTask', (args) => {
      const input = args as { taskId: string; expectedRevision: number; description: string }
      if (
        input.taskId !== task?.id ||
        input.expectedRevision !== 1 ||
        input.description !== 'Updated shared context'
      ) {
        throw new Error('Edit the saved parent at its observed revision.')
      }
      evidence.edits += 1
      task = { ...task, description: input.description, state_revision: 2 }
      return ok({ taskId: input.taskId, stateRevision: 2, principal: 'a'.repeat(64) })
    })
  })
  await orcaPage.waitForFunction(() => window.__store?.getState().workspaceSessionReady === true)
  await orcaPage.setViewportSize({ width: 1440, height: 1000 })
  await orcaPage.locator('[data-nav-group="work"]').click()
  await orcaPage
    .getByRole('navigation', { name: 'Work quick links' })
    .getByRole('button', { name: 'Tasks', exact: true })
    .click()
  await expect(orcaPage.getByRole('button', { name: 'Needs You', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await orcaPage.getByRole('button', { name: 'Kanban', exact: true }).click()
  const board = orcaPage.getByRole('region', { name: 'Work board', exact: true })
  await expect(board.locator('[data-work-card]')).toHaveCount(0)
  await expect(board.getByLabel('Task owner')).toHaveValue('mine')
  await board.getByLabel('Company', { exact: true }).selectOption('omnirogue')
  await board.getByLabel('Domain', { exact: true }).selectOption('org_development')
  await board.getByRole('button', { name: 'New task', exact: true }).click()
  const form = orcaPage.getByRole('dialog')
  await expect(form.getByLabel('Company', { exact: true })).toContainText('OmniRogue')
  await expect(form.getByLabel('Department', { exact: true })).toContainText('Development')
  await form.getByLabel('Task', { exact: true }).fill('Deliver the launch plan')
  await form.getByLabel('Notes (optional)').fill('Shared context before any session exists')
  await form.getByRole('button', { name: 'Add step', exact: true }).click()
  await form.getByLabel('Step 1', { exact: true }).fill('AI drafts the launch plan')
  await form.getByRole('button', { name: 'Add step', exact: true }).click()
  await form.getByLabel('Step 2', { exact: true }).fill('Sal reviews the result')
  await form.getByLabel('Due date (optional)').fill('2026-09-30')
  await form.getByRole('combobox', { name: 'Priority', exact: true }).click()
  await orcaPage.getByRole('option', { name: 'High', exact: true }).click()
  await form.locator('input[type="file"]').setInputFiles({
    name: 'launch-reference.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Launch reference')
  })
  await expect(form.getByText('launch-reference.txt', { exact: true })).toBeVisible()
  const cdp = await orcaPage.context().newCDPSession(orcaPage)
  await cdp.send('Page.enable')
  const screenshot = testInfo.outputPath('standalone-task-create.png')
  writeFileSync(screenshot, Buffer.from((await cdp.send('Page.captureScreenshot')).data, 'base64'))
  await testInfo.attach('standalone-task-create', { path: screenshot, contentType: 'image/png' })
  await form.getByRole('button', { name: 'Create task', exact: true }).click()
  await expect(form).toHaveCount(0)
  await expect(board.locator('[data-work-card]')).toHaveCount(1)
  await board.locator('[data-work-card="btk_standalone"]').click()
  await orcaPage.getByRole('button', { name: 'Edit task', exact: true }).click()
  await expect(form.getByLabel('Step 1', { exact: true })).toHaveValue('AI drafts the launch plan')
  await expect(form.getByLabel('Notes (optional)')).toHaveValue(
    'Shared context before any session exists'
  )
  await form.getByLabel('Notes (optional)').fill('Updated shared context')
  await form.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(form).toHaveCount(0)
  await expect(orcaPage.locator('[data-card-sections="btk_standalone"]')).toContainText(
    'Updated shared context'
  )
  const evidence = await electronApp.evaluate(
    () =>
      (globalThis as typeof globalThis & { __standaloneTaskEvidence: unknown })
        .__standaloneTaskEvidence
  )
  expect(evidence).toEqual({ created: 1, sessions: 0, uploads: 1, edits: 1 })
  await cdp.detach()
})
