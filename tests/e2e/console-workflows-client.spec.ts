import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

test('Jobs opens the task-bound composer without restoring consent or launching work', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.getByRole('button', { name: 'Jobs', exact: true }).click()
  await expect(orcaPage.getByRole('heading', { name: 'Jobs', exact: true })).toBeVisible()
  await expect(orcaPage.getByRole('tab', { name: 'Assigned human jobs' })).toBeVisible()
  await orcaPage.getByRole('tab', { name: 'Compose workflow' }).click()
  await expect(orcaPage.getByRole('tab', { name: 'Compose workflow' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await expect(orcaPage.getByLabel('Workflow title', { exact: true })).toBeVisible()
  await expect(orcaPage.getByLabel('Goal ID', { exact: true })).toHaveValue('')
  await expect(orcaPage.getByLabel('Current authority epoch', { exact: true })).toHaveValue('')
  await expect(orcaPage.getByLabel('Acceptance policy (JSON object)', { exact: true })).toHaveValue(
    ''
  )
  await expect(orcaPage.getByLabel('Stage adopting this task', { exact: true })).toBeVisible()
  await expect(orcaPage.getByLabel('Server template', { exact: true })).toHaveCount(0)
  await expect(orcaPage.getByRole('button', { name: /approve/i })).toHaveCount(0)
  await expect(orcaPage.getByRole('button', { name: /preview/i })).toBeDisabled()
  await orcaPage.screenshot({
    path: testInfo.outputPath('console-workflows-compose.png'),
    fullPage: true,
    animations: 'disabled'
  })
  await orcaPage.getByText('Inputs, acceptance and placement', { exact: true }).click()
  await orcaPage.getByRole('button', { name: 'Add acceptance command', exact: true }).click()
  await orcaPage.getByLabel('Program', { exact: true }).fill('node')
  await orcaPage.getByLabel('Arguments (JSON array)', { exact: true }).fill('["--version"]')
  await expect(orcaPage.getByLabel('Timeout (ms)', { exact: true })).toHaveValue('60000')
  await orcaPage.getByLabel('Program', { exact: true }).scrollIntoViewIfNeeded()
  await orcaPage.screenshot({
    path: testInfo.outputPath('console-workflows-acceptance.png'),
    animations: 'disabled'
  })
  await orcaPage.reload()
  await waitForSessionReady(orcaPage)
  await orcaPage.getByRole('button', { name: 'Jobs', exact: true }).click()
  await orcaPage.getByRole('tab', { name: 'Compose workflow' }).click()
  await expect(orcaPage.getByLabel('Current authority epoch', { exact: true })).toHaveValue('')
  await expect(orcaPage.getByLabel('Program', { exact: true })).toHaveCount(0)
  await expect(orcaPage.getByRole('button', { name: /approve/i })).toHaveCount(0)
})
