import { execSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { getTerminalContent } from './helpers/terminal'

/**
 * Live check of the terminal-backed Codex chat's native Effort picker against the REAL
 * CLI: picking a level restarts Codex in the same pane with `codex … resume <thread>`,
 * the picker confirms from the TUI header, and the resumed thread still remembers the
 * conversation. Opt-in:
 *
 *   OMNI_LIVE_CODEX=/Users/me/.local/opt/node/bin/codex pnpm exec playwright test tests/e2e/native-chat-live-codex-relaunch.spec.ts ...
 *
 * The host's ~/.codex is copied (auth + config) into the disposable harness home.
 */
const LIVE_CODEX = process.env.OMNI_LIVE_CODEX ?? ''
const FIRST_PROMPT =
  'UI diagnostic only. Remember the code word PELICAN. Reply exactly CODEX-RELAUNCH-ONE. Do not use tools or change files.'
const SECOND_PROMPT =
  'UI diagnostic only. Reply exactly CODEX-RELAUNCH-TWO followed by a space and the code word I asked you to remember. Do not use tools or change files.'
const OUTCOME_TOAST =
  /Codex is now on|came back with|didn't come back|hasn't reported|didn't start|Could not update option|already using|still working/

test.skip(!LIVE_CODEX, 'set OMNI_LIVE_CODEX=<absolute codex path> to run the live relaunch check')
test.use({ launchEnv: { PATH: `${path.dirname(LIVE_CODEX)}:${process.env.PATH ?? ''}` } })

test('real Codex (terminal-backed): native effort pick restarts on the same thread and keeps the conversation', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  const isolatedHome = await electronApp.evaluate(({ app }) => app.getPath('home'))
  if (isolatedHome === os.homedir()) {
    throw new Error('refusing to seed credentials into the developer home')
  }
  const codexHome = path.join(isolatedHome, '.codex')
  mkdirSync(codexHome, { recursive: true, mode: 0o700 })
  for (const name of [
    'auth.json',
    'config.toml',
    'hooks.json',
    'installation_id',
    'version.json'
  ]) {
    const source = path.join(os.homedir(), '.codex', name)
    if (existsSync(source)) {
      copyFileSync(source, path.join(codexHome, name))
    }
  }
  const annotate = (type: string, description: string): void => {
    test.info().annotations.push({ type, description: description.replace(/\n/g, ' | ') })
  }
  // Why a timeline: a failed relaunch has three possible causes (restart never ran, Codex
  // never came up, header never parsed) that only the store + terminal over time tell apart.
  const consoleLines: string[] = []
  orcaPage.on('console', (message) => consoleLines.push(`${message.type()}: ${message.text()}`))
  orcaPage.on('pageerror', (error) => consoleLines.push(`pageerror: ${error.message}`))
  const timeline: string[] = []
  const snapshotStore = (): Promise<string> =>
    orcaPage.evaluate(() => {
      const state = window.__store!.getState() as never as Record<string, unknown>
      const tabs = Object.values(state.tabsByWorktree as Record<string, unknown[]>)
        .flat()
        .map((tab) => {
          const t = tab as Record<string, unknown>
          return { id: t.id, agent: t.launchAgent, ptyId: t.ptyId, view: t.viewMode }
        })
      const rows = Object.entries(state.agentStatusByPaneKey as Record<string, unknown>).map(
        ([key, row]) => {
          const r = row as Record<string, unknown>
          return {
            key,
            state: r.state,
            updatedAt: r.updatedAt,
            stateStartedAt: r.stateStartedAt,
            thread: (r.providerSession as { id?: string } | undefined)?.id
          }
        }
      )
      return JSON.stringify({
        tabs,
        rows,
        pendingRestarts: Object.keys(state.pendingCodexPaneRestartIds as object),
        pendingStartups: Object.keys(state.pendingCodexPaneRestartStartupByPtyId as object),
        launchConfigs: Object.entries(
          (state.agentLaunchConfigByPaneKey as Record<string, unknown> | undefined) ?? {}
        ).map(([key, config]) => {
          const c = config as Record<string, unknown>
          return { key: key.slice(-12), agentArgs: c.agentArgs, sessionOptions: c.sessionOptions }
        })
      })
    })
  // The PTY's own main buffer holds the shell line that launched the agent even after the
  // TUI took the alternate screen — the one place that shows the command that really ran.
  const snapshotMainBuffer = (): Promise<string> =>
    orcaPage.evaluate(async () => {
      const state = window.__store!.getState() as never as Record<string, unknown>
      const tab = Object.values(state.tabsByWorktree as Record<string, unknown[]>)
        .flat()
        .map((candidate) => candidate as Record<string, unknown>)
        .find((candidate) => candidate.launchAgent === 'codex')
      const ptyId = typeof tab?.ptyId === 'string' ? tab.ptyId : null
      if (!ptyId || !window.api?.pty?.getMainBufferSnapshot) {
        return `no pty (${String(ptyId)})`
      }
      const snapshot = await window.api.pty
        .getMainBufferSnapshot(ptyId, { scrollbackRows: 400 })
        .catch((error: unknown) => ({ data: `snapshot failed: ${String(error)}` }))
      const data = (snapshot?.data ?? '')
        .replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g'), '')
        .replace(/\s+/g, ' ')
      return `alt=${String((snapshot as { alternateScreen?: boolean } | null)?.alternateScreen)} HEAD<<${data.slice(0, 700)}>> TAIL<<${data.slice(-700)}>>`
    })
  const record = async (label: string): Promise<void> => {
    const toasts = await orcaPage
      .locator('[data-sonner-toast]')
      .allInnerTexts()
      .catch(() => [])
    const terminal = (await getTerminalContent(orcaPage).catch(() => '')).trim()
    const store = await snapshotStore()
    const mainBuffer = await snapshotMainBuffer()
    // Why ps: the OS process table is the one record of the argv Codex was really given.
    let processes = ''
    try {
      processes = execSync('ps -axo pid,ppid,command', { encoding: 'utf8' })
        .split('\n')
        .filter((line) => /codex/.test(line) && !/grep|Claude|playwright/.test(line))
        .join(' || ')
    } catch (error) {
      processes = `ps failed: ${String(error)}`
    }
    timeline.push(
      [
        `[${new Date().toISOString()}] ${label}`,
        `  store=${store}`,
        `  toasts=${JSON.stringify(toasts)}`,
        `  main-buffer=${JSON.stringify(mainBuffer)}`,
        `  processes=${processes}`,
        `  terminal-tail=${JSON.stringify(terminal.slice(-700))}`
      ].join('\n')
    )
  }
  try {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await orcaPage.evaluate(async (codexHome) => {
      await window.__store!.getState().updateSettings({
        defaultTuiAgent: 'codex',
        agentDefaultArgs: { codex: '--dangerously-bypass-approvals-and-sandbox' },
        agentDefaultEnv: { codex: { CODEX_HOME: codexHome } },
        experimentalNativeChat: true,
        openAgentTabsInChatByDefault: true,
        // Why off: this is the terminal-backed (PTY) lane, not the app-server one.
        experimentalStructuredNativeChat: false
      })
    }, codexHome)

    const tabsBefore = await orcaPage.locator('[data-testid="sortable-tab"]').count()
    await expect(async () => {
      await orcaPage.keyboard.press('Escape')
      await orcaPage.getByRole('button', { name: 'New tab' }).click({ force: true })
      await expect(orcaPage.getByRole('menuitem', { name: /^Codex(?:\s|$)/i }).first()).toBeVisible(
        { timeout: 5_000 }
      )
    }).toPass({ timeout: 120_000, intervals: [3_000] })
    await orcaPage
      .getByRole('menuitem', { name: /^Codex(?:\s|$)/i })
      .first()
      .click({ force: true })
    await expect
      .poll(() => orcaPage.locator('[data-testid="sortable-tab"]').count(), { timeout: 60_000 })
      .toBeGreaterThan(tabsBefore)

    const chat = orcaPage.locator('[data-native-chat-root="true"]').first()
    await expect(chat).toBeVisible({ timeout: 120_000 })
    // A startup screen (trust / update) may cover the composer: take its recommended choice.
    const intervention = orcaPage.locator('[data-native-chat-startup-intervention]').first()
    const composer = chat.locator('textarea').first()
    await expect(async () => {
      if (await intervention.isVisible()) {
        annotate(
          'intervention',
          (await intervention.getAttribute('data-native-chat-startup-intervention')) ?? ''
        )
        await intervention.getByRole('button').first().click()
      }
      await expect(composer).toBeVisible({ timeout: 5_000 })
    }).toPass({ timeout: 120_000, intervals: [2_000] })
    await orcaPage.screenshot({ path: testInfo.outputPath('01-terminal-backed-chat.png') })

    // Turn one: gives Codex a thread to resume and plants the code word.
    await composer.fill(FIRST_PROMPT)
    await composer.press('Enter')
    await expect
      .poll(() => getTerminalContent(orcaPage), { timeout: 240_000, intervals: [2_000] })
      .toMatch(/CODEX-RELAUNCH-ONE[\s\S]*CODEX-RELAUNCH-ONE/)
    await expect(chat).toHaveAttribute('data-native-chat-working', 'false', { timeout: 60_000 })
    await orcaPage.screenshot({ path: testInfo.outputPath('02-first-answer.png') })

    // The options pill lists real effort radios (no "Choose in agent picker…") with the hint.
    const optionsPill = chat
      .getByRole('button', { name: /Effort|Reasoning|Session options/ })
      .first()
    await expect(optionsPill).toBeVisible({ timeout: 30_000 })
    const effortRows = orcaPage.getByRole('menuitemradio')
    await expect(async () => {
      await orcaPage.keyboard.press('Escape')
      await optionsPill.click()
      await expect.poll(() => effortRows.count(), { timeout: 5_000 }).toBeGreaterThan(1)
    }).toPass({ timeout: 90_000, intervals: [3_000] })
    const efforts = await effortRows.allInnerTexts()
    annotate('efforts', efforts.join(' | '))
    expect(efforts.join('\n')).not.toContain('Choose in agent picker')
    await expect(
      orcaPage.getByText('Changing this restarts Codex and resumes the conversation.').first()
    ).toBeVisible()
    await orcaPage.screenshot({ path: testInfo.outputPath('03-effort-menu.png') })

    // Pick a level Codex is not on: High unless High is current, then Medium.
    const checked = await effortRows.evaluateAll((rows) =>
      rows.map((row) => ({
        text: row.textContent ?? '',
        checked:
          row.getAttribute('aria-checked') === 'true' ||
          row.getAttribute('data-state') === 'checked'
      }))
    )
    annotate(
      'current',
      checked
        .filter((row) => row.checked)
        .map((row) => row.text)
        .join(' | ')
    )
    const target = checked.some(
      (row) => row.checked && /High/.test(row.text) && !/Extra/.test(row.text)
    )
      ? 'Medium'
      : 'High'
    await record('before pick')
    await effortRows
      .filter({ hasText: new RegExp(`^${target}$`) })
      .first()
      .click()
    annotate('picked', target)

    const toast = orcaPage.getByText(OUTCOME_TOAST).first()
    for (let tick = 0; tick < 90; tick += 1) {
      await record(`after pick +${tick}s`)
      if (await toast.isVisible().catch(() => false)) {
        break
      }
      await orcaPage.waitForTimeout(1_000)
    }
    await expect(toast).toBeVisible({ timeout: 5_000 })
    const outcome = await toast.innerText()
    annotate('outcome', outcome)
    await orcaPage.screenshot({ path: testInfo.outputPath('04-relaunch-outcome.png') })
    // The terminal behind the chat shows what the restarted pane actually ran.
    await orcaPage.getByRole('radio', { name: 'Terminal', exact: true }).first().click()
    await orcaPage.waitForTimeout(1_500)
    await orcaPage.screenshot({ path: testInfo.outputPath('04b-terminal-after-relaunch.png') })
    await record('terminal view after outcome')
    await orcaPage.getByRole('radio', { name: 'Chat', exact: true }).first().click()
    await orcaPage.waitForTimeout(1_000)
    expect(outcome).toMatch(/Codex is now on/)
    expect(outcome).toMatch(new RegExp(target))

    // The pill shows the applied value and is usable again right after the resume.
    await expect(optionsPill).toContainText(new RegExp(target), { timeout: 30_000 })
    await expect(chat).toHaveAttribute('data-native-chat-working', 'false', { timeout: 60_000 })
    await expect(async () => {
      await orcaPage.keyboard.press('Escape')
      await optionsPill.click()
      await expect.poll(() => effortRows.count(), { timeout: 5_000 }).toBeGreaterThan(1)
    }).toPass({ timeout: 60_000, intervals: [3_000] })
    await orcaPage.screenshot({ path: testInfo.outputPath('05-effort-menu-after-resume.png') })
    await orcaPage.keyboard.press('Escape')
    annotate('terminal-after-resume', (await getTerminalContent(orcaPage)).slice(-1500))

    // Turn two on the resumed thread: the model must still hold the first turn's code word.
    await expect(composer).toBeVisible({ timeout: 30_000 })
    await composer.fill(SECOND_PROMPT)
    await composer.press('Enter')
    await expect
      .poll(() => getTerminalContent(orcaPage), { timeout: 240_000, intervals: [2_000] })
      .toMatch(/CODEX-RELAUNCH-TWO\s+PELICAN/)
    await orcaPage.waitForTimeout(2_000)
    await orcaPage.screenshot({ path: testInfo.outputPath('06-second-answer.png') })
    annotate('chat-text', (await chat.innerText()).slice(0, 2500))
  } finally {
    writeFileSync(testInfo.outputPath('relaunch-timeline.log'), `${timeline.join('\n\n')}\n`)
    writeFileSync(testInfo.outputPath('renderer-console.log'), `${consoleLines.join('\n')}\n`)
    rmSync(codexHome, { recursive: true, force: true })
  }
})
