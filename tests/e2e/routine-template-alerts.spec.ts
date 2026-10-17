import { captureRoutineProof } from './helpers/routine-proof-evidence'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady, waitForActiveWorktree } from './helpers/store'

test('Briefing template exposes presets, notification states and a durable delivery receipt', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  test.setTimeout(150_000)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const directory = mkdtempSync(join(tmpdir(), 'routine-template-proof-'))
  const script = join(directory, 'provider.cjs')
  writeFileSync(
    script,
    `const status = (state, extra = {}) => process.stdout.write('\\x1b]9999;' + JSON.stringify({state, prompt:'', agentType:'codex', ...extra}) + '\\x07');
status('done', {sessionBoundary:true}); process.stdout.write('› Ask Codex to do anything\\n');
setTimeout(() => status('working', {prompt:process.argv.at(-1)}), 1000);
setTimeout(() => { process.stdout.write('\\nBriefing ready.\\n'); status('done', {lastAssistantMessage:'Briefing ready.'}); }, 3500);
setTimeout(() => process.exit(0), 15000);`
  )
  try {
    await orcaPage.evaluate(
      async (command) => {
        await window.__store!.getState().updateSettingsOrThrow({
          defaultTuiAgent: 'codex',
          agentCmdOverrides: { codex: command }
        })
      },
      `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`
    )
    await orcaPage.getByRole('radio', { name: 'Conversations', exact: true }).click()
    // A routine is started from the same + as any conversation.
    await orcaPage.locator('[data-new-conversation]').focus()
    await orcaPage.keyboard.press('ArrowDown')
    await orcaPage.getByRole('menuitem', { name: 'Routine', exact: true }).click()
    const editor = orcaPage.getByRole('dialog')
    await editor.getByRole('button', { name: 'Start from template' }).click()
    await expect(
      orcaPage.getByRole('button', { name: /Personal.*Briefing|Productivity.*Briefing/ })
    ).toBeVisible()
    await captureRoutineProof(orcaPage, testInfo, 'template-picker')
    await orcaPage
      .getByRole('button', { name: /Personal.*Briefing|Productivity.*Briefing/ })
      .click()
    await expect(editor.getByRole('textbox', { name: 'Automation name' })).toHaveValue('Briefing')
    await expect(editor.getByRole('textbox', { name: 'Hour', exact: true })).toHaveValue('8')
    await expect(editor.getByRole('textbox', { name: 'Minute', exact: true })).toHaveValue('30')
    await expect(editor.locator('[data-routine-repositories]')).toBeVisible()
    await expect(editor.locator('[data-routine-output]')).toBeVisible()
    await editor.getByRole('tab', { name: 'Notifications', exact: true }).click()
    await expect(editor.getByText('Notify me when this routine finishes')).toBeVisible()
    await captureRoutineProof(orcaPage, testInfo, 'notifications-native-account-state', editor)
    // Simulated account responses exercise the UI states without signing in or posting messages.
    for (const [label, response] of [
      ['signed-out', { authenticated: false, connection: null }],
      ['slack-unavailable', { authenticated: true, connection: null }],
      [
        'connected',
        {
          authenticated: true,
          connection: { id: 'T_TEST', title: 'Test workspace (simulated)' },
          ownerEmail: 'owner@example.com'
        }
      ]
    ] as const) {
      await electronApp.evaluate(({ ipcMain }, value) => {
        ipcMain.removeHandler('alerts:slack:status')
        ipcMain.handle('alerts:slack:status', () => value)
        ipcMain.removeHandler('alerts:slack:listChannels')
        ipcMain.handle('alerts:slack:listChannels', () => [
          { id: 'C_TEST', name: 'test-alerts-simulated' }
        ])
      }, response)
      await editor.getByRole('button', { name: 'Refresh connection', exact: true }).click()
      await expect(editor.getByRole('status')).toContainText(
        label === 'signed-out'
          ? 'Sign in to your company account'
          : label === 'slack-unavailable'
            ? 'Slack is not connected'
            : 'Test workspace (simulated)'
      )
      await captureRoutineProof(orcaPage, testInfo, `notifications-${label}-simulated`, editor)
    }
    await editor.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(editor).toHaveCount(0)
    await expect(
      orcaPage.getByRole('button', { name: 'Open routine Briefing', exact: true })
    ).toBeVisible()
    await orcaPage.getByRole('button', { name: 'More options for Briefing' }).click()
    await orcaPage.getByRole('menuitem', { name: 'Run now', exact: true }).click()
    await orcaPage.getByRole('button', { name: /^Briefing Weekdays/ }).click()
    await orcaPage.getByRole('tab', { name: /^Runs/ }).click()
    const results = orcaPage
      .locator('[data-routine-delivery-results]')
      .filter({ hasText: 'Desktop' })
      .first()
    await expect(results).toBeVisible({ timeout: 60_000 })
    await expect(results).not.toContainText('Unconfirmed.', { timeout: 20_000 })
    await expect(results).toContainText(/Chat.*Delivered/)
    await expect(orcaPage.getByText('1 run · 1 completed', { exact: true })).toBeVisible()
    await captureRoutineProof(orcaPage, testInfo, 'briefing-run-history')
  } finally {
    rmSync(directory, { force: true, recursive: true })
  }
})
