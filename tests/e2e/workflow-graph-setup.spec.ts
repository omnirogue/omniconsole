import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import type { Page } from '@stablyai/playwright-test'

/**
 * ＋ → Workflow in the real app: "Describe a workflow" opens the chat-style setup for a custom
 * workflow graph, and Discover opens its template drawn as the graph it will run, with the Models
 * card above it. The e2e home is isolated, so no model is signed in: Run stays disabled and says why.
 */
async function openWorkflow(page: Page, item: string): Promise<void> {
  const newConversation = page.locator('[data-new-conversation]')
  await expect(newConversation).toBeVisible()
  // A click starts a default conversation; the menu of kinds opens on hover, and after a choice
  // re-arms only once the pointer really moves after a quiet moment (useHoverRearmOnMove).
  await page.waitForTimeout(1_000)
  await page.mouse.move(0, 0, { steps: 4 })
  await newConversation.hover()
  await page.getByRole('menuitem', { name: 'Workflow', exact: true }).hover()
  await page.getByRole('menuitem', { name: item, exact: true }).click()
}

test('＋ → Workflow opens a described workflow and the Discover graph with its models', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.getByRole('radio', { name: 'Conversations', exact: true }).click()

  await openWorkflow(orcaPage, 'Describe a workflow')
  await expect(orcaPage.getByRole('region', { name: 'Describe the workflow' })).toBeVisible()
  await expect(orcaPage.getByRole('textbox', { name: 'Workflow description' })).toBeVisible()
  await expect(
    orcaPage.getByRole('textbox', { name: 'What should the workflow work on?' })
  ).toBeVisible()
  await expect(orcaPage.getByRole('button', { name: 'Run', exact: true })).toBeDisabled()
  await orcaPage.screenshot({
    path: testInfo.outputPath('01-describe.png'),
    animations: 'disabled'
  })

  // Council left the menu; Discover is drawn the same way, as the graph it will run.
  await openWorkflow(orcaPage, 'Discover')
  const steps = orcaPage.getByRole('group', { name: 'Workflow steps' })
  await expect(steps.getByRole('button', { name: /^Find, Do/ })).toBeVisible()
  await expect(steps.getByRole('button', { name: /^Verify, Review/ })).toBeVisible()
  await expect(steps.getByRole('button', { name: /^Report, Synthesize/ })).toBeVisible()
  // Selecting a step opens it for editing; its inputs only offer earlier steps.
  await steps.getByRole('button', { name: /^Report/ }).click()
  await expect(orcaPage.getByRole('region', { name: 'Edit step' })).toBeVisible()
  await expect(orcaPage.getByRole('button', { name: 'Run', exact: true })).toBeDisabled()
  await orcaPage.screenshot({
    path: testInfo.outputPath('02-discover.png'),
    animations: 'disabled'
  })

  // The Models card: every step listed, a tier for all of them or for one, and a combo on a step.
  const models = orcaPage.getByRole('region', { name: 'Models', exact: true })
  await expect(models).toBeVisible()
  for (const title of ['Brief', 'Scout', 'Find', 'Verify', 'Report']) {
    await expect(models.getByRole('listitem').filter({ hasText: title })).toBeVisible()
  }
  const every = models.getByRole('group', { name: 'Tier for every step' })
  await every.getByRole('button', { name: 'Cheap', exact: true }).click()
  await expect(every.getByRole('button', { name: 'Cheap', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  const report = models.getByRole('listitem').filter({ hasText: 'Report' })
  await expect(report.getByRole('button', { name: /^Change model: .*haiku/i })).toBeVisible()
  await models
    .getByRole('group', { name: 'Tier for Report' })
    .getByRole('button', { name: 'Frontier', exact: true })
    .click()
  await expect(report.getByRole('button', { name: /^Change model: .*opus/i })).toBeVisible()
  await expect(every.getByRole('button', { name: 'Cheap', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false'
  )
  await expect(models.getByRole('textbox', { name: 'Describe the models you want' })).toBeVisible()
  await orcaPage.screenshot({ path: testInfo.outputPath('03-models.png'), animations: 'disabled' })

  await models.getByRole('button', { name: 'Adjust tiers' }).click()
  await expect(orcaPage.getByRole('heading', { name: 'Frontier', exact: true })).toBeVisible()
  await expect(orcaPage.getByRole('button', { name: 'Remove from Cheap' }).first()).toBeVisible()
  await orcaPage.screenshot({ path: testInfo.outputPath('04-tiers.png'), animations: 'disabled' })
  await orcaPage.keyboard.press('Escape')

  // A combo on Discover's finders: models from any providers, one agent each.
  const find = models.getByRole('listitem').filter({ hasText: 'Find' })
  await find.getByRole('button', { name: 'Combo', exact: true }).click()
  await expect(orcaPage.getByPlaceholder('Search models or families…')).toBeVisible()
  await orcaPage.screenshot({ path: testInfo.outputPath('05-combo.png'), animations: 'disabled' })
})
