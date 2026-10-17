import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

test('Need Speed preserves mode, independent prompts and retry identity across renderer reload', async ({
  orcaPage,
  electronApp,
  testRepoPath
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  // This uses the real rebuilt runtime capability. Only work dispatch is mocked below.
  const capability = await orcaPage.evaluate(async () => {
    const result = await window.api.runtime.call({ method: 'status.get', params: {} })
    return result.ok ? (result.result as { capabilities?: string[] }).capabilities : []
  })
  expect(capability).toContain('session-prep.routing.v1')
  await orcaPage.evaluate(async (root) => {
    await window.__store!.getState().updateSettings({ companyWorkRoot: root })
  }, testRepoPath)
  await electronApp.evaluate(({ ipcMain }) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
    )._invokeHandlers
    const original = handlers.get('runtime:call')!
    const requests: { requestId: string; text: string; source: Record<string, string> }[] = []
    const attempts = new Map<string, number>()
    ipcMain.removeHandler('runtime:call')
    ipcMain.handle('runtime:call', (event, request) => {
      if (request.method === 'needSpeed.fixture.requests') {
        return { ok: true, result: requests }
      }
      if (request.method === 'sessionPrep.listForSource') {
        return { ok: true, result: { batches: [] } }
      }
      if (request.method === 'sessionPrep.request') {
        const params = request.params
        requests.push(params)
        const attempt = (attempts.get(params.requestId) ?? 0) + 1
        attempts.set(params.requestId, attempt)
        if (params.text === 'Write the independent release summary.' && attempt === 1) {
          return {
            ok: false,
            error: { code: 'unavailable', message: 'Temporary test failure. Retry this prompt.' }
          }
        }
        return { ok: true, result: { batchId: `fixture-${params.requestId}` } }
      }
      // No real preparation or launch RPC is permitted by this dialog test.
      if (request.method.startsWith('sessionPrep.')) {
        throw new Error('Unexpected preparation RPC in Need Speed fixture')
      }
      return original(event, request)
    })
  })

  await orcaPage.setViewportSize({ width: 720, height: 850 })
  await orcaPage.getByRole('button', { name: 'Sessions', exact: true }).click()
  const open = async () => {
    const trigger = orcaPage.locator('[data-new-conversation]').first()
    await trigger.focus()
    await trigger.press('ArrowDown')
    await orcaPage.getByRole('menuitem', { name: /Need Speed/ }).click()
    await expect(orcaPage.getByRole('dialog', { name: 'Need Speed?' })).toBeVisible()
  }
  await open()
  const dialog = orcaPage.getByRole('dialog', { name: 'Need Speed?' })
  await expect(dialog).toContainText('Experimental')
  const automatic = dialog.getByRole('checkbox', { name: 'Route new objectives from conversation' })
  await expect(automatic).toBeChecked()
  const mode = dialog.getByRole('combobox', { name: 'Routing mode' })
  await mode.click()
  await orcaPage
    .getByRole('option', { name: 'Off — use previous model choices', exact: true })
    .click()
  await expect
    .poll(() => orcaPage.evaluate(() => window.__store!.getState().settings?.dispatchRoutingMode))
    .toBe('off')
  await expect(automatic).toBeDisabled()
  await mode.click()
  await orcaPage
    .getByRole('option', { name: 'On — choose models automatically', exact: true })
    .click()
  await expect
    .poll(() => orcaPage.evaluate(() => window.__store!.getState().settings?.dispatchRoutingMode))
    .toBe('live')
  await expect(automatic).toBeEnabled()
  await automatic.uncheck()
  await expect
    .poll(() =>
      orcaPage.evaluate(() => window.__store!.getState().settings?.automaticOutcomeDispatch)
    )
    .toBe(false)
  await dialog.getByLabel('Prompt 1', { exact: true }).fill('Fix the isolated checkout type error.')
  await dialog.getByRole('button', { name: 'Add prompt', exact: true }).click()
  await dialog
    .getByLabel('Prompt 2', { exact: true })
    .fill('Write the independent release summary.')
  await expect(dialog.getByRole('textbox')).toHaveCount(2)
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  await dialog.getByRole('heading', { name: 'Need Speed?' }).hover()
  await dialog.screenshot({ path: testInfo.outputPath('need-speed-independent-prompts.png') })
  await orcaPage.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await open()
  await expect(dialog.getByLabel('Prompt 1', { exact: true })).toHaveValue(
    'Fix the isolated checkout type error.'
  )
  await expect(dialog.getByLabel('Prompt 2', { exact: true })).toHaveValue(
    'Write the independent release summary.'
  )
  await expect(automatic).not.toBeChecked()
  await dialog.getByRole('button', { name: 'Start work', exact: true }).click()
  await expect(dialog.getByText('Accepted', { exact: true })).toHaveCount(1)
  await expect(dialog.getByRole('alert')).toContainText('Temporary test failure')
  await dialog.getByRole('heading', { name: 'Need Speed?' }).hover()
  await dialog.screenshot({ path: testInfo.outputPath('need-speed-partial-acceptance.png') })
  // Replacing the renderer must retain accepted work and the original retry identity.
  await orcaPage.reload()
  await waitForSessionReady(orcaPage)
  await orcaPage.getByRole('button', { name: 'Sessions', exact: true }).click()
  await open()
  await expect(dialog.getByText('Accepted', { exact: true })).toHaveCount(1)
  await expect(mode).toContainText('On — choose models automatically')
  await expect(automatic).not.toBeChecked()
  await expect(dialog.getByLabel('Prompt 2', { exact: true })).toHaveValue(
    'Write the independent release summary.'
  )
  await expect(dialog.getByLabel('Prompt 2', { exact: true })).toHaveAttribute('readonly', '')
  expect(
    await orcaPage.evaluate(async () => {
      const result = await window.api.runtime.call({ method: 'needSpeed.fixture.requests' })
      return result.ok ? (result.result as unknown[]).length : -1
    })
  ).toBe(2)
  await dialog.getByRole('button', { name: 'Retry unfinished', exact: true }).click()
  await expect(dialog.getByText('Accepted', { exact: true })).toHaveCount(2)
  const requests = await orcaPage.evaluate(async () => {
    const result = await window.api.runtime.call({ method: 'needSpeed.fixture.requests' })
    if (!result.ok) {
      throw new Error('Missing test request capture')
    }
    return result.result as {
      requestId: string
      text: string
      source: { entryPoint: string; routingMode: string; worktreeId: string }
    }[]
  })
  expect(requests).toHaveLength(3)
  expect(requests.map((request) => request.text)).toEqual([
    'Fix the isolated checkout type error.',
    'Write the independent release summary.',
    'Write the independent release summary.'
  ])
  expect(requests[0].requestId).not.toBe(requests[1].requestId)
  expect(requests[1]).toEqual(requests[2])
  for (const request of requests) {
    expect(request.source.entryPoint).toBe('need-speed')
    expect(request.source.routingMode).toBe('live')
    expect(request.source.worktreeId).toBeTruthy()
  }
  await dialog.getByRole('button', { name: 'Clear accepted prompts', exact: true }).click()
  await expect(dialog.getByRole('textbox')).toHaveCount(1)
  await expect(dialog.getByLabel('Prompt 1', { exact: true })).toBeEmpty()
})
