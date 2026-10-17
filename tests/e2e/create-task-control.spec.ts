import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  configureGoldenStubAgent,
  getGoldenStubAgentLaunchEnv,
  GOLDEN_STUB_READY_MARKER,
  launchGoldenStubAgentIntoChat
} from './helpers/golden-stub-agent'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForTerminalOutput } from './helpers/terminal'

test.use({ launchEnv: getGoldenStubAgentLaunchEnv() })

async function openAttention(page: Page): Promise<void> {
  const button = page.getByRole('button', { name: /^Attention(?:\s+\d+ need you)?$/ }).first()
  if ((await button.count()) === 0) {
    await page
      .getByRole('button', { name: /^Work(?:\s|$)/ })
      .first()
      .click()
    await button.waitFor({ timeout: 10_000 })
  }
  await button.click()
}

async function startStubSession(page: Page): Promise<void> {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  // The tab menu only lists account-verified agents (since #117); the stub has no account, so
  // the "New tab → Codex" path never shows it. Use the launch state that menu ends up calling —
  // the same path next-step-controls.spec.ts drives green today.
  await configureGoldenStubAgent(page, { chatView: true })
  await launchGoldenStubAgentIntoChat(page)
  await waitForTerminalOutput(page, GOLDEN_STUB_READY_MARKER, 20_000)
}

// OBSOLETE: the prefilled task form this test drives was removed on 2026-09-19 by 63ff9494da
// ("fix(tasks): redirect retired hub creation controls to Jira"). CreateTaskDialog is now a
// "Tasks now live in Jira" redirect with no title/Company/Department/Project fields, and
// TaskFilingFields is orphaned. The replacement is covered by the unit tests in
// src/renderer/src/components/tasks/CreateTaskDialog.test.tsx. PREFER DELETING THIS FILE.
test.skip('Up next Session details opens a prefilled editable task form', async ({ orcaPage }) => {
  await startStubSession(orcaPage)
  await openAttention(orcaPage)

  await orcaPage.getByRole('button', { name: 'Up next', exact: true }).first().click()
  // Session details fold to one facts line (brief 78 #3); the card is one disclosure away.
  await orcaPage.locator('[data-next-action-details-toggle]').last().click()
  const details = orcaPage.locator('[data-next-action-session-details]').last()
  await expect(details.getByRole('button', { name: 'Attach', exact: true })).toBeVisible()
  await details.getByRole('button', { name: 'Create', exact: true }).click()

  const dialog = orcaPage.getByRole('dialog')
  await expect(dialog.getByText('Track this work until it is finished.')).toBeVisible()
  const title = dialog.getByLabel('Task', { exact: true })
  // Inferred from the conversation, and editable.
  await expect(title).not.toHaveValue('')
  await title.fill('Simplify OmniConsole handoffs')
  await expect(title).toHaveValue('Simplify OmniConsole handoffs')
  await expect(dialog.getByLabel('Company')).toBeVisible()
  await expect(dialog.getByLabel('Department')).toBeVisible()
  await expect(dialog.getByLabel('Project (optional)')).toBeVisible()
  await expect(
    dialog.getByText('Everyone involved. Who acts next is decided by ＋ Add Next, not here.')
  ).toBeVisible()

  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog.getByText('Track this work until it is finished.')).toHaveCount(0)
  // Cancelling tracks nothing: the conversation is still a conversation.
  await expect(details.getByRole('button', { name: 'Create', exact: true })).toBeVisible()
  await expect(details.locator('[data-next-action-fact="task"]')).toContainText('none')
})
