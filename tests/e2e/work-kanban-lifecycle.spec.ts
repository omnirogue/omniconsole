import { test, expect } from './helpers/orca-app'
import { writeFileSync } from 'node:fs'
import type { WorkCard } from '../../src/shared/console-work-home-contract'

test.use({ seedTestRepo: false })

test('Work keeps one outcome card across agent updates and separates session conditions', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  const shared = {
    source: 'omniconsole-ide',
    company_slug: 'omnirogue',
    org_unit_id: 'org_development',
    owner_employee_id: 'emp_sal',
    due_date: '2026-09-20',
    triage_state: 'filed'
  }
  const cards: WorkCard[] = [
    {
      ...shared,
      id: 'btk_backlog1',
      title: 'Plan the next release',
      status: 'pending',
      kanban_status: 'backlog'
    },
    {
      ...shared,
      id: 'btk_ready001',
      title: 'Validate the API',
      status: 'open',
      kanban_status: 'ready'
    },
    {
      ...shared,
      id: 'btk_running1',
      title: 'Deliver one shared outcome',
      status: 'running',
      execution_state: 'FAILED',
      kanban_status: 'in_progress',
      next_action: 'Continue the remaining acceptance checks',
      kanban_badges: [
        { kind: 'sessions', label: '50 sessions', count: 50 },
        { kind: 'failed_attempt', label: 'Failed attempt' }
      ]
    },
    {
      ...shared,
      id: 'btk_waiting1',
      title: 'Obtain API access',
      status: 'awaiting_approval',
      kanban_status: 'waiting',
      kanban_reason: 'Access grant pending'
    },
    {
      ...shared,
      id: 'btk_review01',
      title: 'Verify the candidate',
      status: 'candidate_complete',
      kanban_status: 'review'
    },
    {
      ...shared,
      id: 'btk_done0001',
      title: 'Accepted delivery',
      status: 'verified_complete',
      kanban_status: 'done'
    },
    {
      ...shared,
      id: 'btk_cancel01',
      title: 'Cancelled request',
      status: 'cancelled',
      kanban_disposition: 'cancelled'
    },
    {
      ...shared,
      id: 'btk_incoming',
      title: 'Untriaged request',
      status: 'open',
      triage_state: 'inbox'
    },
    {
      ...shared,
      id: 'btk_subtask1',
      title: 'Check one part of the outcome',
      status: 'running',
      parent_task_id: 'btk_running1'
    },
    {
      id: 'btk_internal',
      title: 'Internal messaging support',
      source: 'omni-console',
      status: 'open'
    }
  ]
  const boardData = {
    items: cards,
    total: cards.length,
    capped: false,
    companies: [
      {
        id: 'co_omnirogue',
        slug: 'omnirogue',
        name: 'OmniRogue',
        domains: [{ id: 'org_development', name: 'Development' }]
      }
    ]
  }
  await electronApp.evaluate(({ ipcMain }, board) => {
    const ok = (data: unknown) => ({ ok: true, data })
    const register = (name: string, read: (args: unknown) => unknown) => {
      ipcMain.removeHandler(name)
      ipcMain.handle(name, (_event, args) => read(args))
    }
    register('consoleCompanies:me', () =>
      ok({ ok: true, user: { employee_id: 'emp_sal', role: 'member' }, companies: [] })
    )
    register('consoleCompanies:folders', () => ok({ ok: true, companies: [] }))
    register('backoffice:listTodo', () => ({
      ok: true,
      baseUrl: 'https://fixture.test',
      employeeId: 'emp_sal',
      items: [],
      awaitingVerification: [],
      generatedAt: null,
      nextCursor: null
    }))
    register('consoleHandoffs:recipients', () =>
      ok({ employees: [{ id: 'emp_sal', name: 'Sal' }] })
    )
    register('consoleHandoffs:list', () => ok({ assignee: 'emp_sal', threads: [] }))
    register('consoleWorkflows:listHumanActions', () => ok({ jobs: [] }))
    register('backoffice:feed', () => ({
      ok: true,
      body: { projects: [], people: [], threads: [] }
    }))
    register('consoleWorkflows:listWork', () => ok(board))
    register('consoleWorkflows:getTask', (args) => {
      const { taskId } = args as { taskId: string }
      const card = board.items.find((item) => item.id === taskId)
      if (!card) {
        throw new Error('The board must open its original task ID.')
      }
      return ok({
        ...card,
        acceptance_criteria: 'All agreed acceptance checks pass.',
        state_revision: 7,
        description: 'Shared outcome brief',
        priority: 'normal',
        sequential_steps: ['Draft with AI', 'Sal reviews'],
        publicationPrincipal: 'a'.repeat(64)
      })
    })
    register('consoleWorkflows:updateTask', (args) => {
      const input = args as {
        taskId: string
        expectedRevision: number
        description?: string
        dueDate?: string
        priority?: string
        sequentialSteps?: string[]
      }
      if (
        input.taskId !== 'btk_running1' ||
        input.expectedRevision !== 7 ||
        input.description !== 'Shared context for employees and agents' ||
        input.dueDate !== '2026-09-30' ||
        input.priority !== 'high' ||
        JSON.stringify(input.sequentialSteps) !==
          JSON.stringify(['Draft with AI', 'Sal reviews', 'Publish approved result'])
      ) {
        throw new Error('The saved task details must match the edited form.')
      }
      return ok({ taskId: input.taskId, stateRevision: 8, principal: 'a'.repeat(64) })
    })
    register('consoleHandoffs:uploadFile', (args) => {
      const input = args as {
        taskId: string
        expectedPrincipal: string
        purpose: string
        file: { name: string; size: number; sha256: string; contentBase64: string }
      }
      if (
        input.taskId !== 'btk_running1' ||
        input.expectedPrincipal !== 'a'.repeat(64) ||
        input.purpose !== 'task' ||
        input.file.name !== 'launch-brief.txt' ||
        Buffer.from(input.file.contentBase64, 'base64').toString() !== 'Shared launch reference'
      ) {
        throw new Error('Attach the exact selected file to the same task and person.')
      }
      return ok({ path: 'uploads/launch-brief.txt', sha256: input.file.sha256 })
    })
    register('consoleWorkflows:getTaskLifecycle', (args) =>
      ok({ task: { id: (args as { taskId: string }).taskId } })
    )
    register('consoleWorkflows:listTaskActivity', () => ok([]))
    register('consoleWorkflows:listWorkSessions', () => ok({ sessions: [] }))
    register('consoleWorkflows:taskSessions', () =>
      ok({
        sessions: Array.from({ length: 50 }, (_, index) => ({
          id: `ses_child${String(index).padStart(3, '0')}`,
          title: `Outcome session ${index + 1}`,
          state: index === 0 ? 'failed' : 'completed',
          machineId: 'Fleet'
        }))
      })
    )
  }, boardData)
  await orcaPage.waitForFunction(() => window.__store?.getState().workspaceSessionReady === true)
  await orcaPage.setViewportSize({ width: 1680, height: 1000 })
  await orcaPage.locator('[data-nav-group="work"]').click()
  await orcaPage
    .getByRole('navigation', { name: 'Work quick links' })
    .getByRole('button', { name: 'Tasks', exact: true })
    .click()
  await expect(orcaPage.getByRole('button', { name: 'Needs You', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(
    orcaPage.getByRole('navigation', { name: 'Work lenses' }).getByRole('button')
  ).toHaveText(['Needs You0', 'Waiting For0', 'Kanban', 'All'])
  // Why scoped: the sidebar gained its own Kanban destination (SidebarKanbanNavButton),
  // so the page-wide name now matches two buttons; this test drives the in-page lens.
  const kanbanLens = orcaPage
    .getByRole('navigation', { name: 'Work lenses' })
    .getByRole('button', { name: 'Kanban', exact: true })
  await kanbanLens.click()
  await expect(orcaPage.getByRole('button', { name: 'Needs You', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false'
  )
  const board = orcaPage.getByRole('region', { name: 'Work board', exact: true })
  await expect(board.locator('[data-work-column] h3')).toHaveText([
    // Proposed leads the board (WORK_COLUMNS = [PROPOSED_COLUMN, ...TASK_STATES]); it is a
    // tag-derived lane, and no fixture card carries the `proposed` tag, so it stays empty.
    'Proposed · 0',
    'Backlog · 1',
    'Ready · 1',
    'In Progress · 1',
    'Waiting · 1',
    'Review · 1',
    'Done · 1'
  ])
  const active = board.locator('[data-work-column="in-progress"] [data-work-card="btk_running1"]')
  await expect(active).toContainText('50 sessions')
  await expect(active).toContainText('Failed attempt')
  await expect(active.locator('[data-work-company]')).toHaveText(['OmniRogue'])
  await expect(active).toContainText('· Development')
  await expect(board.locator('[data-work-card]')).toHaveCount(6)
  await expect(board.getByRole('heading', { name: /^Failed/ })).toHaveCount(0)
  await expect(board.getByText('Waiting: Access grant pending')).toBeVisible()
  const cdp = await orcaPage.context().newCDPSession(orcaPage)
  await cdp.send('Page.enable')
  const boardScreenshot = testInfo.outputPath('work-six-outcomes.png')
  writeFileSync(
    boardScreenshot,
    Buffer.from((await cdp.send('Page.captureScreenshot')).data, 'base64')
  )
  await testInfo.attach('work-six-outcomes', { path: boardScreenshot, contentType: 'image/png' })
  await active.click()
  await orcaPage.getByRole('button', { name: 'Edit task', exact: true }).click()
  const editor = orcaPage.getByRole('dialog')
  await editor.getByLabel('Notes (optional)').fill('Shared context for employees and agents')
  await editor.getByRole('button', { name: 'Add step' }).click()
  await editor.getByLabel('Step 3', { exact: true }).fill('Publish approved result')
  await editor.getByLabel('Due date (optional)').fill('2026-09-30')
  await editor.getByRole('combobox', { name: 'Priority', exact: true }).click()
  await orcaPage.getByRole('option', { name: 'High', exact: true }).click()
  await editor.locator('input[type="file"]').setInputFiles({
    name: 'launch-brief.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Shared launch reference')
  })
  await expect(editor.getByText('launch-brief.txt', { exact: true })).toBeVisible()
  const formScreenshot = testInfo.outputPath('task-details-plan-files.png')
  writeFileSync(
    formScreenshot,
    Buffer.from((await cdp.send('Page.captureScreenshot')).data, 'base64')
  )
  await testInfo.attach('task-details-plan-files', {
    path: formScreenshot,
    contentType: 'image/png'
  })
  // The form must be free of errors before the save, so a failure below names the save
  // rather than a panel that was already complaining when the dialog opened.
  await expect(editor.getByRole('alert')).toHaveText([])
  await editor.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(editor.getByRole('alert')).toHaveText([])
  await expect(editor).toHaveCount(0)
  await kanbanLens.click()
  // Updates arrive through the same IPC read used by the live refresh; the original ID persists.
  for (const [state, raw] of [
    ['waiting', 'running'],
    ['review', 'candidate_complete'],
    ['done', 'verified_complete']
  ]) {
    await electronApp.evaluate(
      ({ ipcMain }, updatedBoard) => {
        ipcMain.removeHandler('consoleWorkflows:listWork')
        ipcMain.handle('consoleWorkflows:listWork', () => ({ ok: true, data: updatedBoard }))
        ipcMain.removeHandler('consoleWorkflows:getTask')
        ipcMain.handle('consoleWorkflows:getTask', (_event, { taskId }) => ({
          ok: true,
          data: {
            ...updatedBoard.items.find((card) => card.id === taskId),
            acceptance_criteria: 'All agreed acceptance checks pass.'
          }
        }))
      },
      {
        ...boardData,
        items: cards.map((card) =>
          card.id === 'btk_running1' ? { ...card, status: raw, kanban_status: state } : card
        )
      }
    )
    await board.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(
      board.locator(`[data-work-column="${state}"] [data-work-card="btk_running1"]`)
    ).toBeVisible()
    await expect(board.locator('[data-work-card="btk_running1"]')).toHaveCount(1)
  }
  await orcaPage.setViewportSize({ width: 1000, height: 800 })
  await board.getByLabel('Task owner').selectOption('visible')
  await board.getByRole('button', { name: 'List', exact: true }).click()
  await expect(board.locator('[data-work-card]')).toHaveCount(10)
  await expect(board.locator('[data-work-card="btk_cancel01"]')).toContainText('Cancelled')
  await board.locator('[data-work-card="btk_running1"]').click()
  const detail = orcaPage.locator('[data-card-sections="btk_running1"]')
  await expect(detail).toBeVisible()
  await expect(detail).toContainText('All agreed acceptance checks pass.')
  await expect(detail).toContainText('2026-09-20')
  await expect(detail.getByText('Done', { exact: true })).toBeVisible()
  await expect(
    orcaPage.locator('[data-task-sessions="btk_running1"] [data-task-session]')
  ).toHaveCount(50)
  const detailScreenshot = testInfo.outputPath('work-original-task-detail.png')
  writeFileSync(
    detailScreenshot,
    Buffer.from((await cdp.send('Page.captureScreenshot')).data, 'base64')
  )
  await testInfo.attach('work-original-task-detail', {
    path: detailScreenshot,
    contentType: 'image/png'
  })
  const lastSession = orcaPage.locator('[data-task-session="ses_child049"]')
  await lastSession.scrollIntoViewIfNeeded()
  await expect(lastSession).toContainText('Outcome session 50')
  const sessionsScreenshot = testInfo.outputPath('work-fifty-sessions.png')
  writeFileSync(
    sessionsScreenshot,
    Buffer.from((await cdp.send('Page.captureScreenshot')).data, 'base64')
  )
  await testInfo.attach('work-fifty-sessions', {
    path: sessionsScreenshot,
    contentType: 'image/png'
  })
  await cdp.detach()
})
