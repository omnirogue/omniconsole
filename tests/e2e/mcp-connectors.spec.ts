import { test, expect } from './helpers/orca-app'

test('connectors settings adds and removes a local server in an isolated account', async ({
  orcaPage: page
}, testInfo) => {
  await page.evaluate(() => window.__store!.getState().openSettingsPage())
  await page.getByRole('button', { name: 'Connectors', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Add connector' })).toBeVisible()
  await page.getByLabel('Name', { exact: true }).fill('connector-ui-smoke')
  await page.getByLabel('Connection type').click()
  await page.getByRole('option', { name: 'Local command', exact: true }).click()
  await page.getByLabel('Executable', { exact: true }).fill('node')
  await page.getByRole('button', { name: 'Add connector', exact: true }).click()
  await expect(page.getByText('connector-ui-smoke', { exact: true })).toBeVisible({
    timeout: 30_000
  })
  await expect(
    page.getByText('Configured · connection not verified', { exact: true })
  ).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('connectors-light.png') })
  await page.evaluate(async () => {
    await window.__store!.getState().updateSettings({ theme: 'dark' })
  })
  await expect(page.locator('html')).toHaveClass(/dark/)
  await page.screenshot({ path: testInfo.outputPath('connectors-dark.png') })
  await page.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(page.getByText('Remove from this account?', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Remove', exact: true }).last().click()
  await expect(page.getByText('connector-ui-smoke', { exact: true })).not.toBeVisible()
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(page.getByText('connector-ui-smoke', { exact: true })).not.toBeVisible()
})
