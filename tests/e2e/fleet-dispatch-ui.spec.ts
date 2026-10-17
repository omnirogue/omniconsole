import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActiveTerminalManager } from './helpers/terminal'
import {
  FLEET_UI_FIXTURE_MACHINE,
  FLEET_UI_FIXTURE_TITLE,
  installFleetDispatchUiFixture
} from './helpers/fleet-dispatch-ui-fixture'
import { seedRecoveredFleetDispatchUiConversation } from './helpers/fleet-dispatch-ui-recovery'

test('recovered fleet work opens a compact row summary before native transcript and logs', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  testInfo.annotations.push({
    type: 'evidence-scope',
    description: 'Rendered candidate UI with simulated service replies; not a live fleet run.'
  })
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await orcaPage.setViewportSize({ width: 1600, height: 788 })
  await orcaPage.evaluate(async () => {
    await window.__store!.getState().updateSettings({ theme: 'light' })
  })
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)
  await installFleetDispatchUiFixture(electronApp)
  await seedRecoveredFleetDispatchUiConversation(orcaPage)
  await orcaPage.getByRole('radio', { name: 'Conversations', exact: true }).click()
  await orcaPage.getByRole('button', { name: 'SSH hosts', exact: true }).click()
  const row = orcaPage.locator('[data-fleet-row="fixture-recovered-row"]')
  await expect
    .poll(async () => {
      await orcaPage.evaluate(() => window.dispatchEvent(new Event('focus')))
      return row.count()
    })
    .toBe(1)
  await row.hover()
  // Hover protects the group even when assertions or screenshots take longer than its idle timer.
  await orcaPage.waitForTimeout(6500)
  await expect(row).toContainText(FLEET_UI_FIXTURE_TITLE)
  await expect(row).toHaveAttribute('data-session-density', 'compact')
  await expect(row).not.toContainText('Working')
  await expect(row).not.toContainText(FLEET_UI_FIXTURE_MACHINE)
  const groupKey = await row.evaluate((element) =>
    element.closest('[data-session-group]')?.getAttribute('data-session-group')
  )
  const group = orcaPage.locator(`[data-session-group=${JSON.stringify(groupKey)}]`)
  await orcaPage.screenshot({
    path: testInfo.outputPath('fixture-fleet-compact-row.png'),
    animations: 'disabled'
  })
  await row.getByRole('button', { name: 'More options', exact: true }).click()
  await orcaPage.getByRole('menuitem', { name: 'View summary', exact: true }).click()
  const dialog = orcaPage.locator('[data-slot="sheet-content"]')
  await expect(
    dialog.getByRole('heading', { name: FLEET_UI_FIXTURE_TITLE, exact: true })
  ).toBeVisible()
  await expect(dialog).toContainText('Work is continuing. Steps finished: 0 of 1.')
  await expect(dialog.getByText('Working', { exact: true })).toBeVisible()
  await expect(dialog.getByText(FLEET_UI_FIXTURE_MACHINE, { exact: true })).toBeVisible()
  await expect(dialog.getByRole('tab', { name: 'Transcript', exact: true })).toHaveCount(0)
  await expect(dialog.getByRole('log', { name: 'Server events', exact: true })).toHaveCount(0)
  const selectedRows = orcaPage.locator('[role="option"][aria-selected="true"]')
  const selectedBefore = await selectedRows.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('data-session-key'))
  )
  await dialog.hover()
  await orcaPage.keyboard.press('ArrowDown')
  await expect(dialog).toBeVisible()
  expect(
    await selectedRows.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-session-key'))
    )
  ).toEqual(selectedBefore)
  // The sidebar's idle auto-fold runs after five seconds away from the group.
  await orcaPage.waitForTimeout(6500)
  await expect(row).toHaveCount(0)
  await expect(dialog).toBeVisible()
  await orcaPage.screenshot({
    path: testInfo.outputPath('fixture-fleet-summary.png'),
    animations: 'disabled'
  })
  await dialog.locator('summary').filter({ hasText: 'Technical details' }).click()
  await expect(dialog.getByRole('region', { name: 'Auto-advance', exact: true })).toHaveCount(0)
  await expect(dialog.getByRole('heading', { name: 'Local execution', exact: true })).toHaveCount(0)
  const transcriptTab = dialog.getByRole('tab', { name: 'Transcript', exact: true })
  await expect(transcriptTab).toHaveCount(1)
  await transcriptTab.scrollIntoViewIfNeeded()
  await expect(transcriptTab).toBeInViewport({ ratio: 1 })
  const result = dialog.getByText('Fixture result: the proposal now has a clear next step.', {
    exact: true
  })
  await result.scrollIntoViewIfNeeded()
  await expect(result).toBeInViewport({ ratio: 1 })
  await expect(dialog).toContainText('The runner has not confirmed the capture is complete.')
  await orcaPage.screenshot({
    path: testInfo.outputPath('fixture-fleet-transcript.png'),
    animations: 'disabled'
  })
  await dialog.getByRole('tab', { name: 'Session log', exact: true }).click()
  await expect(dialog.locator('pre[aria-label="Session log"]')).toContainText(
    'Fixture: improve this proposal.'
  )
  await orcaPage.screenshot({
    path: testInfo.outputPath('fixture-fleet-session-log.png'),
    animations: 'disabled'
  })
  await dialog.getByRole('tab', { name: 'Event log', exact: true }).click()
  await expect(dialog.getByRole('log', { name: 'Server events', exact: true })).toContainText(
    'Fixture runner started'
  )
  await orcaPage.screenshot({
    path: testInfo.outputPath('fixture-fleet-event-log.png'),
    animations: 'disabled'
  })
  await orcaPage.evaluate(async () => {
    await window.__store!.getState().updateSettings({ theme: 'dark' })
  })
  await expect(orcaPage.locator('html')).toHaveClass(/dark/)
  await orcaPage.screenshot({
    path: testInfo.outputPath('fixture-fleet-event-log-dark.png'),
    animations: 'disabled'
  })
  await orcaPage.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  if ((await row.count()) === 0) {
    await group
      .getByRole('button', { name: /^Expand / })
      .first()
      .click()
  }
  await row.hover()
  await row.getByRole('button', { name: 'More options', exact: true }).click()
  await orcaPage.getByRole('menuitem', { name: 'View summary', exact: true }).click()
  await expect(dialog.getByRole('tab', { name: 'Transcript', exact: true })).toHaveCount(0)
  await expect(dialog.locator('details').first()).not.toHaveAttribute('open', '')
})
