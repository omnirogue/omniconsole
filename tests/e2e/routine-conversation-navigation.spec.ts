import { captureRoutineProof } from './helpers/routine-proof-evidence'
import { waitForRoutineWorkspace } from './helpers/routine-workspace-readiness'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady, waitForActiveWorktree } from './helpers/store'

test('Work and Agents toggle and a routine opens its conversation instead of management', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  const workspaceId = await waitForActiveWorktree(orcaPage)
  await expect(orcaPage.locator('button[data-nav-group]')).toHaveCount(2)
  await expect(orcaPage.locator('[data-nav-group="companies"]')).toHaveCount(0)
  const agents = orcaPage.locator('button[data-nav-group="agents"]')
  await expect(agents).toHaveAttribute('aria-expanded', 'false')
  await agents.click()
  await expect(agents).toHaveAttribute('aria-expanded', 'true')
  await agents.click()
  await expect(orcaPage.locator('[data-nav-group-members="agents"]')).toHaveCount(0)

  await waitForRoutineWorkspace(orcaPage, workspaceId)

  await orcaPage.evaluate(async (workspaceId) => {
    const state = window.__store!.getState()
    await state.updateSettingsOrThrow({
      experimentalNativeChat: true,
      agentCmdOverrides: { claude: 'cat' }
    })
    const created = await window.api.runtime.call({
      method: 'automation.create',
      params: {
        name: 'Advertising conversation proof',
        prompt: 'Review the ads for this company.',
        agentId: 'claude',
        workspaceMode: 'existing',
        workspace: `id:${workspaceId}`,
        timezone: 'UTC',
        rrule: '0 9 * * *',
        dtstart: Date.now(),
        enabled: false
      }
    })
    if (!created.ok) {
      throw new Error(created.error.message)
    }
  }, workspaceId)
  await orcaPage.getByRole('radio', { name: 'Conversations', exact: true }).click()
  await orcaPage
    .getByRole('button', { name: 'Open routine Advertising conversation proof', exact: true })
    .click()
  await expect(orcaPage.locator('[data-routine-conversation]')).toContainText(
    'Advertising conversation proof'
  )
  await expect(orcaPage.locator('[data-native-chat-root="true"]')).toBeVisible()
  await expect(
    orcaPage.getByRole('button', { name: 'What are the highest probability ads we can turn on?' })
  ).toBeVisible()
  await expect(
    orcaPage.getByRole('button', { name: 'What are the lowest probability ads we can shut off?' })
  ).toBeVisible()
  const tab = orcaPage.locator('[data-testid="sortable-tab"][data-active="true"]')
  const tabId = await tab.getAttribute('data-tab-id')
  expect(tabId).toBeTruthy()
  await orcaPage
    .getByRole('button', { name: 'Open routine Advertising conversation proof', exact: true })
    .click()
  await expect(tab).toHaveAttribute('data-tab-id', tabId!)
  await captureRoutineProof(orcaPage, testInfo, 'opened-routines')
  await orcaPage.getByRole('radio', { name: 'Conversations', exact: true }).click()
  await expect(orcaPage.locator(`[data-session-row*="${tabId}"]`)).toHaveCount(0)
  await captureRoutineProof(orcaPage, testInfo, 'opened-conversations')
  await tab.hover()
  await tab.locator('[data-tab-close-button]').click()
  await expect(orcaPage.locator(`[data-tab-id="${tabId}"]`)).toHaveCount(0)
  await captureRoutineProof(orcaPage, testInfo, 'closed-chat-conversations')
  await orcaPage.getByRole('radio', { name: 'Conversations', exact: true }).click()
  const routine = orcaPage.getByRole('button', {
    name: 'Open routine Advertising conversation proof',
    exact: true
  })
  await expect(routine).toBeVisible()
  await captureRoutineProof(orcaPage, testInfo, 'closed-chat-routine-remains')
  await routine.click()
  await expect(orcaPage.locator('[data-routine-conversation]')).toContainText(
    'Advertising conversation proof'
  )
  const reopenedId = await tab.getAttribute('data-tab-id')
  expect(reopenedId).not.toBe(tabId)
  await captureRoutineProof(orcaPage, testInfo, 'reopened-routines')
  await orcaPage.getByRole('radio', { name: 'Conversations', exact: true }).click()
  await expect(orcaPage.locator(`[data-session-row*="${reopenedId}"]`)).toHaveCount(0)
  await captureRoutineProof(orcaPage, testInfo, 'reopened-conversations')
  await orcaPage.getByRole('radio', { name: 'Conversations', exact: true }).click()
  await orcaPage
    .getByRole('button', { name: 'More options for Advertising conversation proof' })
    .click()
  await orcaPage.getByRole('menuitem', { name: 'Delete routine', exact: true }).click()
  await expect(orcaPage.getByRole('dialog')).toContainText('conversation and run history')
  await orcaPage.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(routine).toHaveCount(0)
  await expect(orcaPage.locator(`[data-tab-id="${reopenedId}"]`)).toHaveCount(0)
  await captureRoutineProof(orcaPage, testInfo, 'deleted-routines')
  await orcaPage.getByRole('radio', { name: 'Conversations', exact: true }).click()
  await expect(orcaPage.locator(`[data-session-row*="${reopenedId}"]`)).toHaveCount(0)
  await captureRoutineProof(orcaPage, testInfo, 'deleted-conversations')
})
