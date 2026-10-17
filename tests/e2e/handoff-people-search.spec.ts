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

test('handoff people search retries explicitly and shows roster photos before typing', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  await electronApp.evaluate(({ ipcMain }) => {
    const register = (name: string, result: unknown) => {
      ipcMain.removeHandler(name)
      ipcMain.handle(name, () => result)
    }
    register('consoleCompanies:me', {
      ok: true,
      data: {
        ok: true,
        user: { employee_id: 'emp_sal', role: 'member' },
        company_scope: 'none',
        companies: []
      }
    })
    register('consoleCompanies:folders', { ok: true, data: { ok: true, companies: [] } })
    register('consoleCompanies:orgChart', {
      ok: false,
      error: { code: 'forbidden', message: 'Org chart unavailable', status: 403 }
    })
    register('consoleHandoffs:recipients', {
      ok: false,
      error: { code: 'forbidden', message: 'Test account access needs updating.', status: 403 }
    })
  })
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await configureGoldenStubAgent(orcaPage, { chatView: true })
  await launchGoldenStubAgentIntoChat(orcaPage)
  await waitForTerminalOutput(orcaPage, GOLDEN_STUB_READY_MARKER, 20_000)
  const attention = orcaPage
    .getByRole('button', { name: /^Attention(?:\s+\d+ need you)?$/ })
    .first()
  if ((await attention.count()) === 0) {
    await orcaPage
      .getByRole('button', { name: /^Work(?:\s|$)/ })
      .first()
      .click()
  }
  await attention.click()
  await orcaPage.getByRole('button', { name: 'Up next', exact: true }).first().click()
  const composer = orcaPage.locator('[data-up-next-chain]').last()
  await composer.getByRole('button', { name: '+ Person', exact: true }).click()
  // Send to a person opens straight on To: there is no relationship to pick first.
  const picker = composer.getByRole('group', { name: 'To', exact: true })
  await expect(
    picker.getByText('Test account access needs updating.', { exact: true })
  ).toBeVisible()
  await expect(picker.getByText('No active teammate matches.')).toHaveCount(0)
  await orcaPage.screenshot({ path: testInfo.outputPath('handoff-people-access-error.png') })
  await electronApp.evaluate(({ ipcMain }) => {
    const fixture = { requests: 0, release: () => {} }
    const pending = new Promise((resolve) => {
      fixture.release = () =>
        resolve({
          ok: true,
          data: {
            peopleSource: 'directory',
            employees: [
              { id: 'emp_sal', name: 'Sal', companies: [], department: 'Development' },
              {
                id: 'emp_josh',
                name: 'Josh',
                companies: [],
                photo_url:
                  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
              },
              ...Array.from({ length: 6 }, (_, index) => ({
                id: `emp_fixture_${index}`,
                name: `Fixture teammate ${index}`,
                companies: []
              }))
            ]
          }
        })
    })
    ;(
      globalThis as typeof globalThis & {
        __handoffRosterRetry?: typeof fixture
      }
    ).__handoffRosterRetry = fixture
    ipcMain.removeHandler('consoleHandoffs:recipients')
    ipcMain.handle('consoleHandoffs:recipients', () => {
      fixture.requests += 1
      return pending
    })
  })
  await picker.getByRole('button', { name: 'Refresh people', exact: true }).click()
  await expect(picker.getByText('Loading people…', { exact: true })).toBeVisible()
  const requests = await electronApp.evaluate(() => {
    const target = globalThis as typeof globalThis & {
      __handoffRosterRetry?: { requests: number; release: () => void }
    }
    const fixture = target.__handoffRosterRetry!
    fixture.release()
    delete target.__handoffRosterRetry
    return fixture.requests
  })
  expect(requests).toBe(1)
  const search = picker.getByRole('textbox', { name: 'Add a person…' })
  const josh = picker.getByRole('button', { name: 'Josh', exact: true })
  await expect(josh).toBeVisible()
  const sal = picker.getByRole('button', { name: 'Sal', exact: true })
  await expect(sal).toBeVisible()
  await expect(search).toHaveValue('')
  await expect(josh.locator('img')).toBeVisible()
  await expect
    .poll(() =>
      josh.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)
    )
    .toBe(true)
  await orcaPage.screenshot({ path: testInfo.outputPath('handoff-people-focused.png') })
  await search.fill('Josh')
  await expect(sal).toHaveCount(0)
  await josh.click()
  await expect(picker.getByRole('button', { name: 'Remove Josh', exact: true })).toBeVisible()
  // Nothing follows the send, so the person picked takes it over unless the sender waits.
  await expect(
    composer.getByRole('checkbox', {
      name: 'Wait for their OK before my next steps run',
      exact: true
    })
  ).not.toBeChecked()
  await expect(composer.locator('[data-person-send-consequence]')).toHaveText("It becomes Josh's.")
})
