import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

test('provider links, device codes, browser fallback and cancellation render in Electron', async ({
  orcaPage,
  electronApp
}) => {
  await waitForSessionReady(orcaPage)
  await electronApp.evaluate(({ ipcMain }) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
    )._invokeHandlers
    const original = handlers.get('runtime:call')!
    let provider = 'codex'
    let complete = false
    ipcMain.removeHandler('runtime:call')
    ipcMain.handle('runtime:call', (event, request) => {
      if (!request.method.startsWith('accounts.login.')) {
        return original(event, request)
      }
      if (request.method === 'accounts.login.start') {
        provider = request.params.provider
        complete = false
      }
      if (request.method === 'accounts.login.submitCode') {
        complete = true
      }
      return {
        ok: true,
        result: {
          id: '77a5d86a-fc3b-4f3f-ad28-5dd8637a7f32',
          provider,
          status: complete ? 'complete' : 'waiting',
          authorizationUrl:
            provider === 'codex'
              ? 'https://auth.openai.com/codex/device'
              : 'https://claude.com/cai/oauth/authorize?state=fixture',
          ...(provider === 'codex' ? { userCode: 'ABCD-EFGHI' } : { canSubmitCode: true })
        }
      }
    })
    ipcMain.removeHandler('shell:openUrl')
    ipcMain.handle('shell:openUrl', () => undefined)
  })
  await orcaPage.evaluate(async () => {
    await window.__store!.getState().updateSettings({ uiLanguage: 'en' })
    window.__store!.getState().openSettingsPage()
  })
  await orcaPage.getByText('AI Provider Accounts', { exact: true }).click()
  await orcaPage
    .locator('#accounts-codex')
    .getByRole('button', { name: 'Add Account', exact: true })
    .click()
  await expect(orcaPage.getByRole('dialog', { name: 'Sign in to Codex' })).toBeVisible()
  await expect(orcaPage.getByText('ABCD-EFGHI', { exact: true })).toBeVisible()
  await orcaPage.getByRole('button', { name: 'Open Codex sign-in', exact: true }).click()
  await orcaPage
    .getByRole('dialog')
    .getByRole('button', { name: 'Close', exact: true })
    .last()
    .click()
  await expect(orcaPage.getByRole('dialog')).toHaveCount(0)
  await orcaPage
    .locator('#accounts-claude')
    .getByRole('button', { name: 'Add Account', exact: true })
    .click()
  await expect(orcaPage.getByRole('dialog', { name: 'Sign in to Claude' })).toBeVisible()
  await orcaPage.getByRole('button', { name: 'Open Claude sign-in', exact: true }).click()
  await orcaPage
    .getByLabel('If the browser gives you a code, paste it here')
    .fill('fixture-code#state')
  await orcaPage.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(orcaPage.getByRole('dialog')).toHaveCount(0)
})
