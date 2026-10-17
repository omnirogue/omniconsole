import { test, expect } from './helpers/orca-app'

// Why: deterministic Console fixtures so the rendered Attention launcher and the three
// Tasks views can be checked (and screenshotted) without a live hub.
test('Attention shows the launch strip and Tasks separates Needs You, Waiting For and All', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  await electronApp.evaluate(({ ipcMain }) => {
    const base = {
      parent_thread_id: null,
      delivery_id: null,
      due_at: null,
      files: [] as unknown[],
      reviews: [] as unknown[]
    }
    const received = {
      ...base,
      id: 'hth_received',
      board_task_id: 'btk_review01',
      author_employee_id: 'emp_gamma',
      recipient_employee_id: 'emp_sal',
      title: 'Review the launch copy',
      state: 'open',
      action: 'review',
      updated: '2026-09-11T09:00:00Z'
    }
    const sent = {
      ...base,
      id: 'hth_sent',
      board_task_id: 'btk_deck001',
      author_employee_id: 'emp_sal',
      recipient_employee_id: 'emp_iris',
      title: 'Final deck for review',
      state: 'open',
      action: 'review',
      updated: '2026-09-11T10:00:00Z'
    }
    const finished = {
      ...received,
      id: 'hth_done',
      title: 'Approved pricing page',
      state: 'resolved',
      updated: '2026-09-10T10:00:00Z'
    }
    const register = (name: string, fn: (...args: unknown[]) => unknown) => {
      ipcMain.removeHandler(name)
      ipcMain.handle(name, (_event, ...args) => fn(...args))
    }
    register('backoffice:listTodo', () => ({
      ok: true,
      baseUrl: 'https://fixture.test',
      employeeId: 'emp_sal',
      generatedAt: '2026-09-11T10:30:00Z',
      items: [
        {
          task_id: 'btk_decide01',
          title: 'Choose the rollout date',
          company_slug: 'omnirogue',
          status: 'awaiting_decision',
          state_revision: 3,
          kind: 'decision',
          decision_id: 'dec_fixture',
          who: 'emp_sal',
          why: 'A decision is waiting on you.',
          // Why: since b2a6d160f6 (2026-09-13) Needs You lists people's handoffs only — a Todo
          // row counts only when the hub ties it to a handoff thread, or a reply is waiting
          // (isHumanHandoffRow, src/shared/backoffice-work-views.ts:173-186). The id is one no
          // handoff fixture serves, so this row is not folded onto hth_received's row.
          primary_action: {
            label: 'Decide',
            method: 'POST',
            external: false,
            handoff_thread_id: 'hth_decide01'
          }
        },
        {
          task_id: 'btk_verify01',
          title: 'Landing page copy',
          company_slug: 'betacorp',
          status: 'in_progress',
          state_revision: 2,
          kind: 'fyi',
          who: 'emp_iris',
          why: 'Waiting on Iris to verify.'
        }
      ],
      awaitingVerification: [],
      counts: { total: 2, blocked: 0, replies_waiting: 0, awaiting_verification: 0 },
      truncated: false
    }))
    register('consoleHandoffs:list', (args) => {
      const request = (args ?? {}) as { view?: string; state?: string }
      // Why: a hub that serves the sent view echoes it; the IDE reads an answer without the
      // echo as an older hub's received queue and names the sent list as not provided.
      if (request.view === 'sent') {
        return { ok: true, data: { assignee: 'emp_sal', view: 'sent', threads: [sent] } }
      }
      const threads = request.state === 'resolved' ? [finished] : [received]
      return { ok: true, data: { assignee: 'emp_sal', threads } }
    })
    register('consoleHandoffs:recipients', () => ({
      ok: true,
      data: {
        employees: [
          { id: 'emp_iris', name: 'Iris' },
          { id: 'emp_gamma', name: 'Gamma' }
        ]
      }
    }))
    for (const name of ['get', 'markRead']) {
      register(`consoleHandoffs:${name}`, (input) => {
        const threadId = (input as { threadId: string }).threadId
        const thread = [received, sent, finished].find((row) => row.id === threadId) ?? received
        return { ok: true, data: { thread, files: [], reviews: [], entries: [] } }
      })
    }
  })

  await orcaPage.evaluate(() => {
    window.__store!.getState().setActiveView('attention')
  })
  const launcher = orcaPage.locator('[data-attention-launcher]')
  await expect(launcher.getByText('Start work', { exact: true })).toBeVisible()
  // Why no launch-button assertions: since a20c721765 ("verified launch choices") the strip only
  // renders a favourite or provider whose CLI is detected on the execution host and whose model a
  // live discovery probe returned (AttentionLaunchBar.tsx favoritePlans/providerPlans). A headless
  // runner has no agent CLI and no provider login, so assessWorkAgentAvailability answers
  // 'cli-missing' for every agent and an empty strip is the correct product behaviour here.
  const summary = orcaPage.locator('[data-attention-work-summary]')
  await expect(summary.getByRole('button', { name: '2 need you' })).toBeVisible()
  await expect(summary.getByRole('button', { name: '2 waiting' })).toBeVisible()
  await orcaPage.screenshot({ path: testInfo.outputPath('attention-launcher.png') })

  // Why: "N need you" counts waiting panes too, so it opens Work; Tasks is the console list.
  await summary.getByRole('button', { name: 'Open Tasks' }).click()
  const needsYouLens = orcaPage.locator('[data-work-lens="needs-you"]')
  await needsYouLens.click()
  await expect(needsYouLens).toHaveAttribute('aria-pressed', 'true')
  await expect(
    orcaPage.locator('[data-work-row="todo:btk_decide01::dec_fixture:task"]')
  ).toBeVisible()
  await expect(orcaPage.locator('[data-work-row="handoff:hth_received"]')).toBeVisible()
  await orcaPage.screenshot({ path: testInfo.outputPath('tasks-needs-you.png') })

  await orcaPage.locator('[data-work-lens="waiting"]').click()
  await expect(orcaPage.locator('[data-work-row="handoff:hth_sent"]')).toContainText(
    'Waiting for Iris · review'
  )
  await expect(orcaPage.locator('[data-work-row="todo:btk_verify01:::task"]')).toContainText(
    'Waiting for Iris'
  )
  await orcaPage.screenshot({ path: testInfo.outputPath('tasks-waiting-for.png') })

  await orcaPage.locator('[data-work-lens="all"]').click()
  await expect(orcaPage.locator('[data-work-row="handoff:hth_done"]')).toBeVisible()
  await orcaPage.screenshot({ path: testInfo.outputPath('tasks-all.png') })
})
