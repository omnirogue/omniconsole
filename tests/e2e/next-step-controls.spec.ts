import type { Page } from '@stablyai/playwright-test'
import type { UpNextDraftInput } from '../../src/shared/up-next-types'
import { test, expect } from './helpers/orca-app'
import {
  configureGoldenStubAgent,
  getGoldenStubAgentLaunchEnv,
  GOLDEN_STUB_READY_MARKER,
  launchGoldenStubAgentIntoChat
} from './helpers/golden-stub-agent'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForTerminalOutput } from './helpers/terminal'

/** Native Next actions preserve active work and expose no manual attention deadlines. */

test.use({
  launchEnv: { ...getGoldenStubAgentLaunchEnv(), ORCA_E2E_ENFORCE_SINGLE_INSTANCE_LOCK: '1' }
})

function attentionSidebarButton(page: Page) {
  return page.getByRole('button', { name: /^Attention(?:\s+\d+ need you)?$/ }).first()
}

/** Attention lives under the Work group; open the group when its members are folded away. */
async function openAttention(page: Page): Promise<void> {
  const button = attentionSidebarButton(page)
  if ((await button.count()) === 0) {
    await page
      .getByRole('button', { name: /^Work(?:\s|$)/ })
      .first()
      .click()
    await button.waitFor({ timeout: 10_000 })
  }
  await button.click()
}

async function activePaneKey(page: Page): Promise<string> {
  return page.evaluate(() => {
    const state = window.__store!.getState()
    const tabId = state.activeTabId!
    const leafId = state.terminalLayoutsByTabId[tabId]?.activeLeafId
    return `${tabId}:${leafId}`
  })
}

async function seedNeedsYou(page: Page, paneKey: string): Promise<void> {
  // Why: the stub agent has no hooks; the pane's ask is what puts it under Needs you.
  await page.evaluate((key) => {
    window.__store!.getState().setAgentStatus(
      key,
      {
        state: 'waiting',
        prompt: 'Which one?',
        agentType: 'codex',
        lastAssistantMessage: 'Which one?'
      },
      'Codex pane',
      { updatedAt: Date.now() - 2_000, stateStartedAt: Date.now() - 2_000 }
    )
  }, paneKey)
}

async function startStubSession(page: Page): Promise<string> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  // The tab menu only lists account-verified agents; the fixture is a real local process,
  // but deliberately has no account. Use the same terminal-backed launch state as that menu.
  await configureGoldenStubAgent(page, { chatView: true })
  await launchGoldenStubAgentIntoChat(page)
  await waitForTerminalOutput(page, GOLDEN_STUB_READY_MARKER, 20_000)
  return activePaneKey(page)
}

async function seedPlan(page: Page, paneKey: string, drafts: UpNextDraftInput[]): Promise<void> {
  await page.evaluate(
    async ({ paneKey, drafts }) => {
      const source = {
        worktreeId: window.__store!.getState().activeWorktreeId!,
        paneKey,
        kind: 'pty'
      }
      for (const draft of drafts) {
        const response = await window.api.runtime.call({
          method: 'upNext.append',
          params: { conversationId: source, draft }
        })
        if (!response.ok) {
          throw new Error(response.error.message)
        }
      }
    },
    { paneKey, drafts }
  )
}

test('Up next shows saved agent stages and people, preserves their order, and chooses finish routes', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  // Host writes and folder creation use the real profile runtime on the CI runner.
  test.setTimeout(300_000)
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('consoleCompanies:me')
    ipcMain.handle('consoleCompanies:me', () => ({
      ok: true,
      data: {
        ok: true,
        user: { employee_id: 'emp_sal', role: 'member' },
        company_scope: 'none',
        companies: []
      }
    }))
    ipcMain.removeHandler('consoleCompanies:folders')
    ipcMain.handle('consoleCompanies:folders', () => ({
      ok: true,
      data: { ok: true, companies: [] }
    }))
    ipcMain.removeHandler('consoleCompanies:orgChart')
    ipcMain.handle('consoleCompanies:orgChart', () => ({
      ok: false,
      error: { code: 'forbidden', message: 'Org chart unavailable', status: 403 }
    }))
    ipcMain.removeHandler('consoleHandoffs:recipients')
    ipcMain.handle('consoleHandoffs:recipients', () => ({
      ok: true,
      data: {
        peopleSource: 'directory',
        employees: [
          { id: 'emp_sal', name: 'Sal', companies: [] },
          { id: 'emp_josh', name: 'Josh', companies: [] }
        ]
      }
    }))
  })
  const paneKey = await startStubSession(orcaPage)
  // Plans arrive from the conversation; the manual Add composer is deliberately absent.
  await seedPlan(orcaPage, paneKey, [
    { kind: 'agent', template: 'improve', instruction: 'Repair only the findings.' },
    {
      kind: 'agent',
      template: 'review',
      shape: 'parallel',
      n: 3,
      instruction: 'Return findings only.',
      advanced: { rounds: 3 }
    },
    {
      kind: 'person',
      relationship: 'handoff',
      people: [{ id: 'emp_josh', name: 'Josh' }],
      receive: { note: 'Only the repaired findings.', files: true, transcript: true }
    }
  ])
  const header = orcaPage.locator('[data-conversation-work-header]').first()
  await header.getByRole('button', { name: 'Session context & outcome' }).click()
  const composer = header.locator('[data-up-next-chain]')
  await expect(composer.getByRole('button', { name: 'Add', exact: true })).toHaveCount(0)
  await expect(
    composer.getByRole('button', { name: /^\+ (Prompt|Agent Review|Agent Handoff|Person)$/ })
  ).toHaveCount(0)
  const agents = composer.locator('[data-up-next-block][data-kind="agent"]')
  await expect(agents).toHaveCount(2, { timeout: 30_000 })
  const repair = agents.first()
  const review = agents.last()
  await expect(repair).toHaveAttribute('data-intent', 'handoff')
  await expect(review).toHaveAttribute('data-intent', 'review')
  await repair.locator('[data-up-next-row]').click()
  await expect(repair.getByLabel('Instruction', { exact: true })).toHaveValue(
    'Repair only the findings.'
  )
  await review.locator('[data-up-next-row]').click()
  await expect(review.getByLabel('Instruction', { exact: true })).toHaveValue(
    'Return findings only.'
  )
  await expect(review.getByRole('group', { name: 'Number of agents' })).toContainText('3')
  await review.getByText('Advanced', { exact: true }).click()
  await expect(review.getByRole('spinbutton', { name: 'Rounds', exact: true })).toHaveValue('3')
  await header.getByRole('button', { name: 'Session details', exact: true }).click()
  await expect(header.locator('[data-next-action-session-details]').first()).toBeVisible()
  await header.getByRole('button', { name: 'Session context & outcome' }).click()
  await expect(review.getByLabel('Instruction', { exact: true })).toHaveValue(
    'Return findings only.'
  )
  await expect(agents.first()).toHaveAttribute('data-intent', 'handoff')

  const finish = composer.locator('[data-next-action-when-finished]')
  await expect(finish.getByRole('button', { name: 'Close session', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false'
  )
  await finish.getByRole('button', { name: 'Close session', exact: true }).click()
  await expect(finish.getByRole('button', { name: 'Close session', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await expect(finish.getByRole('combobox')).toHaveCount(0)
  await finish.getByRole('button', { name: 'Save session', exact: true }).click()
  await finish.getByRole('button', { name: 'New folder', exact: true }).click()
  const folderName = orcaPage.getByRole('textbox', { name: 'New folder', exact: true })
  await folderName.fill('Verified releases')
  // Why scoped: Session details carries its own "Create" (a task) beside this form's.
  await orcaPage
    .getByRole('dialog')
    .filter({ has: folderName })
    .getByRole('button', { name: 'Create', exact: true })
    .click()
  await expect(finish.getByRole('combobox', { name: 'Saved session folder' })).toContainText(
    'Verified releases'
  )
  await finish.getByRole('button', { name: 'Close session', exact: true }).click()
  await finish.getByRole('button', { name: 'Close session', exact: true }).click()
  await expect(finish.getByRole('button', { name: 'Close session', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false'
  )

  const person = composer.locator('[data-up-next-block][data-kind="person"]')
  await person.locator('[data-up-next-row]').click()
  await expect(person.getByRole('button', { name: 'Remove Josh', exact: true })).toBeVisible()
  await expect(person.getByLabel('Note', { exact: true })).toHaveValue(
    'Only the repaired findings.'
  )
  await expect(
    person.getByRole('checkbox', {
      name: 'Wait for their OK before my next steps run',
      exact: true
    })
  ).not.toBeChecked()
  await expect(person.locator('[data-person-send-consequence]')).toHaveText("It becomes Josh's.")
  await expect(person).toHaveAttribute('data-end-cap', 'true')
  await expect(person.locator('[data-person-send-everything]')).toBeVisible()
  await expect(composer.getByText(/Connectors|Schedule/)).toHaveCount(0)
  await orcaPage.screenshot({ path: testInfo.outputPath('up-next-edited-stages.png') })
})

test('manual Wait and Snooze are absent while unanswered work remains visible', async ({
  orcaPage
}, testInfo) => {
  const paneKey = await startStubSession(orcaPage)
  await seedNeedsYou(orcaPage, paneKey)
  await openAttention(orcaPage)
  await expect(attentionSidebarButton(orcaPage)).toHaveAccessibleName(/1 need you/)
  await expect(orcaPage.locator('[data-next-step-control="wait"]')).toHaveCount(0)
  await expect(orcaPage.getByRole('button', { name: /^(Snooze|Wait)( |$)/ })).toHaveCount(0)
  await expect(orcaPage.locator('[data-next-step-wait-dial]')).toHaveCount(0)
  await orcaPage.getByRole('radio', { name: 'Conversations' }).click()
  await expect(orcaPage.getByRole('button', { name: /^Hide / }).first()).toBeVisible()
  await orcaPage.screenshot({ path: testInfo.outputPath('next-without-manual-wait.png') })
})

test('Up next keeps a committed block visible when reopened', async ({ orcaPage }, testInfo) => {
  const paneKey = await startStubSession(orcaPage)
  const queueId = await orcaPage.evaluate(async (paneKey) => {
    const id = crypto.randomUUID()
    const response = await window.api.runtime.call({
      method: 'promptQueue.enqueue',
      params: {
        source: { worktreeId: window.__store!.getState().activeWorktreeId!, paneKey, kind: 'pty' },
        id,
        text: 'Check the final result.'
      }
    })
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    return id
  }, paneKey)
  const header = orcaPage.locator('[data-conversation-work-header]').first()
  const open = header.getByRole('button', { name: 'Session context & outcome', exact: true })
  await open.click()
  const composer = header.locator('[data-up-next-chain]')
  const prompt = composer.locator(`[data-up-next-block="pq:${queueId}"]`)
  await expect(prompt).toBeVisible({ timeout: 30_000 })
  await expect(prompt).toContainText('Check the final result.')
  await expect(composer.getByRole('button', { name: 'Add', exact: true })).toHaveCount(0)
  await open.click()
  await expect(composer).toBeHidden()
  await open.click()
  await expect(prompt).toBeVisible()
  await expect(prompt).toContainText('Check the final result.')
  await orcaPage.screenshot({ path: testInfo.outputPath('up-next-committed-reopened.png') })
})
