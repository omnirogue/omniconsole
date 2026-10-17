import { test, expect } from './helpers/orca-app'

test.use({ seedTestRepo: false })

test('moves a shared proposal through ready, waiting, resume and review with real dialogs', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  await electronApp.evaluate(({ ipcMain }) => {
    const card = {
      id: 'btk_proposed1',
      title: 'Improve the shared invite flow',
      status: 'open',
      kanban_status: 'backlog',
      tags: ['Proposed', 'company:betacorp'],
      state_revision: 1,
      kanban_eligible: true,
      source: 'omniconsole-task',
      triage_state: 'filed',
      company_slug: 'omnirogue',
      owner_employee_id: 'emp_other',
      description: 'One idea for both companies.'
    }
    const ok = (data: unknown) => ({ ok: true, data })
    const register = (name: string, handler: (args: unknown) => unknown) => {
      ipcMain.removeHandler(name)
      ipcMain.handle(name, (_event, args) => handler(args))
    }
    register('consoleCompanies:me', () =>
      ok({ user: { employee_id: 'emp_sal', role: 'admin' }, companies: [] })
    )
    register('consoleCompanies:folders', () => ok({ companies: [] }))
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
    register('consoleWorkflows:listWork', () =>
      ok({
        items: [card],
        total: 1,
        capped: false,
        companies: [
          { id: 'co_rogue', slug: 'omnirogue', name: 'OmniRogue', domains: [] },
          { id: 'co_sway', slug: 'betacorp', name: 'BetaCorp', domains: [] }
        ]
      })
    )
    register('consoleWorkflows:getTask', () => ok(card))
    register('consoleWorkflows:updateTask', (args) => {
      const input = args as { tags: string[]; expectedRevision: number }
      if (input.expectedRevision !== card.state_revision) {
        throw new Error('Wrong tag revision')
      }
      card.tags = input.tags
      card.state_revision++
      return ok({ taskId: card.id, stateRevision: card.state_revision })
    })
    register('consoleWorkflows:transitionTask', (args) => {
      const input = args as {
        action: string
        expectedRevision: number
        reason?: string
        waitingOn?: string
        resultRef?: string
      }
      if (input.expectedRevision !== card.state_revision) {
        throw new Error('Wrong transition revision')
      }
      if (input.action === 'wait' && (!input.reason || !input.waitingOn)) {
        throw new Error('Missing wait context')
      }
      if (input.action === 'resume' && !input.reason) {
        throw new Error('Missing resume context')
      }
      if (input.action === 'submit_for_review' && !input.resultRef) {
        throw new Error('Missing review evidence')
      }
      card.kanban_status = (
        {
          ready: 'ready',
          wait: 'waiting',
          resume: 'in_progress',
          submit_for_review: 'review'
        } as Record<string, string>
      )[input.action]
      card.state_revision++
      return ok({ task: card })
    })
  })
  await orcaPage.waitForFunction(() => window.__store?.getState().workspaceSessionReady === true)
  await orcaPage.setViewportSize({ width: 1280, height: 900 })
  await orcaPage.locator('[data-nav-group="work"]').click()
  await orcaPage
    .getByRole('navigation', { name: 'Work quick links' })
    .getByRole('button', { name: 'Tasks', exact: true })
    .click()
  await orcaPage.getByRole('button', { name: 'Kanban', exact: true }).click()
  const board = orcaPage.getByRole('region', { name: 'Work board', exact: true })
  const inLane = (lane: string) =>
    board.locator(`[data-work-column="${lane}"] [data-work-card="btk_proposed1"]`)
  await expect(inLane('proposed')).toBeVisible()
  await expect(inLane('proposed')).toContainText('OmniRogue')
  await expect(inLane('proposed')).toContainText('BetaCorp')
  await board.getByLabel('Task owner').selectOption('visible')
  const move = async (target: string) => {
    await board
      .getByRole('button', { name: 'Move Improve the shared invite flow', exact: true })
      .click()
    await orcaPage.locator(`[data-work-card-move-target="${target}"]`).click()
  }
  await move('ready')
  await expect(inLane('ready')).toBeVisible()
  await move('proposed')
  await expect(inLane('proposed')).toBeVisible()
  await move('waiting')
  const dialog = orcaPage.getByRole('dialog')
  await dialog.getByLabel('Reason', { exact: true }).fill('Waiting for the customer’s credentials')
  await expect(dialog.getByRole('button', { name: 'Move task' })).toBeDisabled()
  await dialog.getByLabel('Waiting for', { exact: true }).fill('Customer IT')
  await expect(dialog.getByRole('button', { name: 'Move task' })).toBeEnabled()
  await orcaPage.screenshot({
    path: testInfo.outputPath('proposed-wait-dialog.png'),
    animations: 'disabled'
  })
  await dialog.getByRole('button', { name: 'Move task' }).click()
  await expect(inLane('waiting')).toBeVisible()
  await move('in-progress')
  await dialog.getByLabel('Reason', { exact: true }).fill('Credentials received and tested')
  await dialog.getByRole('button', { name: 'Move task' }).click()
  await expect(inLane('in-progress')).toBeVisible()
  await move('review')
  await dialog
    .getByLabel('Evidence', { exact: true })
    .fill('https://example.test/review/invite-flow')
  await dialog.getByRole('button', { name: 'Move task' }).click()
  await expect(inLane('review')).toBeVisible()
  await expect(board.locator('[data-work-card="btk_proposed1"]')).toHaveCount(1)
})
