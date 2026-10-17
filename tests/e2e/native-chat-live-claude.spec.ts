import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import type { Page } from '@stablyai/playwright-test'
import { focusActiveTerminalInput } from './helpers/terminal'
import { resolveActiveTabId } from './helpers/terminal-pane-identity'

async function getTerminalContent(page: Page): Promise<string> {
  const tabId = await resolveActiveTabId(page)
  return page.evaluate((id) => {
    const terminal = id ? window.__paneManagers?.get(id)?.getActivePane?.()?.terminal : null
    if (!terminal) {
      return ''
    }
    const buffer = terminal.buffer.active
    return Array.from(
      { length: terminal.rows },
      (_, row) => buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? ''
    ).join('\n')
  }, tabId)
}
import {
  readActiveClaudeKeychainCredentialsStrict,
  writeActiveClaudeKeychainCredentials,
  deleteActiveClaudeKeychainCredentialsStrict
} from '../../src/main/claude-accounts/keychain'
import { detectAgentStartupIntervention } from '../../src/shared/agent-startup-intervention'

/**
 * Live check of the TERMINAL-BACKED chat with the REAL Claude Code. Opt-in:
 *
 *   OMNI_LIVE_CLAUDE=/Users/me/.local/bin/claude pnpm exec playwright test tests/e2e/native-chat-live-claude.spec.ts ...
 *
 * The host's Claude login (~/.claude/.credentials.json, plus the macOS keychain item Claude
 * Code reads on its own) is copied into the disposable harness home; ~/.claude.json is seeded
 * with onboarding complete and NO trusted projects, so the folder-trust screen is exercised.
 */
const LIVE_CLAUDE = process.env.OMNI_LIVE_CLAUDE ?? ''
// Expose only the requested binary ahead of the app PATH.
const LIVE_BIN_DIR = LIVE_CLAUDE
  ? (() => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'omni-live-claude-bin-'))
      symlinkSync(LIVE_CLAUDE, path.join(dir, 'claude'))
      return dir
    })()
  : ''
const FIRST_PROMPT =
  'UI diagnostic only. Remember the code word HERON. Reply exactly CLAUDE-LIVE-ONE. Do not use tools or change files.'
const SECOND_PROMPT =
  'UI diagnostic only. Reply exactly CLAUDE-LIVE-TWO followed by a space and the code word I asked you to remember. Do not use tools or change files.'

test.skip(!LIVE_CLAUDE, 'set OMNI_LIVE_CLAUDE=<absolute claude path> to run the live Claude check')
// Why refuse an ambient config dir: the harness strips HOME but not CLAUDE_CONFIG_DIR, and
// both Claude Code and the app's managed-hook writer honour it — an exporting shell would
// point the harness app at the real ~/.claude (review round 6, finding 3).
if (LIVE_CLAUDE && process.env.CLAUDE_CONFIG_DIR) {
  throw new Error(
    'unset CLAUDE_CONFIG_DIR before the live Claude check; the harness must not inherit it'
  )
}
test.use({ launchEnv: { PATH: `${LIVE_BIN_DIR}:${process.env.PATH ?? ''}` } })

test('real Claude Code (terminal-backed): trust card, prompt, effort/model pickers, exit → Resume keeps the session', async ({
  orcaPage,
  electronApp,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  test.setTimeout(900_000)
  const isolatedHome = await electronApp.evaluate(({ app }) => app.getPath('home'))
  if (isolatedHome === os.homedir()) {
    throw new Error('refusing to seed credentials into the developer home')
  }
  const claudeDir = path.join(isolatedHome, '.claude')
  mkdirSync(claudeDir, { recursive: true, mode: 0o700 })
  const sourceProfile =
    process.env.OMNI_LIVE_CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude')
  const keychainCredentials = await readActiveClaudeKeychainCredentialsStrict(sourceProfile)
  const credentials = path.join(sourceProfile, '.credentials.json')
  if (keychainCredentials) {
    writeFileSync(path.join(claudeDir, '.credentials.json'), keychainCredentials, { mode: 0o600 })
    registerPostElectronShutdownCleanup(() =>
      deleteActiveClaudeKeychainCredentialsStrict(claudeDir)
    )
    await writeActiveClaudeKeychainCredentials(keychainCredentials, claudeDir)
  } else if (existsSync(credentials)) {
    copyFileSync(credentials, path.join(claudeDir, '.credentials.json'))
  }
  // Why a fresh settings file: Sal's carries his own hooks/statusline/permissions; the
  // harness app installs its managed hooks itself on launch.
  writeFileSync(path.join(claudeDir, 'settings.json'), '{}\n')
  writeFileSync(
    path.join(isolatedHome, '.claude.json'),
    `${JSON.stringify({ hasCompletedOnboarding: true, numStartups: 5, theme: 'dark' })}\n`
  )
  copyFileSync(path.join(isolatedHome, '.claude.json'), path.join(claudeDir, '.claude.json'))
  const annotate = (type: string, description: string): void => {
    test.info().annotations.push({ type, description: description.replace(/\n/g, ' | ') })
  }
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
            key: key.slice(-12),
            state: r.state,
            updatedAt: r.updatedAt,
            thread: (r.providerSession as { id?: string } | undefined)?.id
          }
        }
      )
      const sleeping = Object.keys(
        (state.sleepingAgentSessionsByPaneKey as Record<string, unknown> | undefined) ?? {}
      ).map((key) => key.slice(-12))
      return JSON.stringify({ tabs, rows, sleeping })
    })
  const record = async (label: string): Promise<void> => {
    const toasts = await orcaPage
      .locator('[data-sonner-toast]')
      .allInnerTexts()
      .catch(() => [])
    const terminal = (await getTerminalContent(orcaPage).catch(() => '')).trim()
    timeline.push(
      [
        `[${new Date().toISOString()}] ${label}`,
        `  store=${await snapshotStore()}`,
        `  toasts=${JSON.stringify(toasts)}`,
        `  terminal-tail=${JSON.stringify(terminal.slice(-700))}`
      ].join('\n')
    )
  }
  try {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await orcaPage.evaluate(async (claudeDir) => {
      await window.__store!.getState().updateSettings({
        defaultTuiAgent: 'claude',
        agentDefaultEnv: { claude: { CLAUDE_CONFIG_DIR: claudeDir } },
        experimentalNativeChat: true,
        openAgentTabsInChatByDefault: true,
        experimentalStructuredNativeChat: false
      })
    }, claudeDir)

    // CL-01: launch through the tab bar when the menu lists Claude (it does so only once
    // the app verified the account's usage); otherwise launch the same tab through the
    // store, which is what the tab bar does underneath — and record the gate's verdict.
    const tabsBefore = await orcaPage.locator('[data-testid="sortable-tab"]').count()
    let launchedVia = 'menu'
    const menuListsClaude = await (async () => {
      try {
        await expect(async () => {
          await orcaPage.keyboard.press('Escape')
          await orcaPage.getByRole('button', { name: 'New tab' }).click({ force: true })
          await expect(
            orcaPage.getByRole('menuitem', { name: /^Claude(?:\s|$)/i }).first()
          ).toBeVisible({ timeout: 5_000 })
        }).toPass({ timeout: 60_000, intervals: [3_000] })
        return true
      } catch {
        return false
      }
    })()
    await orcaPage.screenshot({ path: testInfo.outputPath('00-new-tab-menu.png') })
    if (menuListsClaude) {
      await orcaPage
        .getByRole('menuitem', { name: /^Claude(?:\s|$)/i })
        .first()
        .click({ force: true })
    } else {
      const menuText = await orcaPage
        .getByRole('menu')
        .first()
        .innerText()
        .catch(() => '(no menu)')
      annotate(
        'availability-gate',
        `Claude not listed after 60 s: ${menuText.replace(/\n/g, ' | ')}`
      )
      // Why record the probe: the menu hides an agent whose usage probe has not verified the
      // account; its stored verdict says whether the harness home lacked credentials.
      annotate(
        'claude-usage-probe',
        await orcaPage.evaluate(() => {
          const state = window.__store!.getState() as never as {
            rateLimits?: Record<string, unknown>
          }
          return JSON.stringify(state.rateLimits?.claude ?? null).slice(0, 1200)
        })
      )
      launchedVia = 'store'
      await orcaPage.keyboard.press('Escape')
      await orcaPage.evaluate((claudePath) => {
        const state = window.__store!.getState()
        const worktreeId = state.activeWorktreeId!
        state.createTab(worktreeId, undefined, undefined, {
          launchAgent: 'claude',
          viewMode: 'chat',
          pendingStartup: {
            command: claudePath,
            env: state.settings?.agentDefaultEnv?.claude,
            launchAgent: 'claude',
            startupCommandDelivery: 'shell-ready'
          }
        } as never)
        state.setActiveTabType('terminal')
      }, LIVE_CLAUDE)
    }
    annotate('launched-via', launchedVia)
    await expect
      .poll(() => orcaPage.locator('[data-testid="sortable-tab"]').count(), { timeout: 60_000 })
      .toBeGreaterThan(tabsBefore)
    const chat = orcaPage.locator('[data-native-chat-root="true"]:visible').first()
    await expect(chat).toBeVisible({ timeout: 120_000 })
    await record('chat mounted')

    // The untrusted harness repo must surface Claude's folder-trust screen as a card, with
    // the composer withheld while it shows. Claude takes a few seconds to draw anything, so
    // wait for its first screen before judging what the chat did with it.
    const intervention = orcaPage.locator('[data-native-chat-startup-intervention]').first()
    const composer = chat.locator('textarea').first()
    await expect
      .poll(() => getTerminalContent(orcaPage), { timeout: 120_000, intervals: [1_000] })
      .toMatch(/trust|Claude Code|Welcome|for shortcuts|❯/i)
    await record('claude first screen')
    await orcaPage.screenshot({ path: testInfo.outputPath('01-first-screen.png') })
    {
      // Why dump + classify: the card is driven by the shared detector over the pane's
      // screen text; running it here on the same text says whether a missing card is a
      // detector gap (new Claude screen wording) or a plumbing gap.
      const fullScreen = await getTerminalContent(orcaPage)
      writeFileSync(testInfo.outputPath('first-screen.txt'), fullScreen)
      const verdict = detectAgentStartupIntervention('claude', fullScreen)
      annotate('detector-on-first-screen', JSON.stringify(verdict))
    }
    let interventionKind = 'none'
    let sawTrust = false
    await expect(async () => {
      if (await intervention.isVisible()) {
        interventionKind =
          (await intervention.getAttribute('data-native-chat-startup-intervention')) ?? ''
        annotate('intervention', interventionKind)
        sawTrust ||= interventionKind === 'trust-prompt'
        await orcaPage.screenshot({ path: testInfo.outputPath('01-startup-card.png') })
        await expect(chat.locator('textarea')).toHaveCount(0)
        await intervention.getByRole('button').first().click()
      }
      // Claude's input prompt is on screen and the composer is back.
      await expect
        .poll(() => getTerminalContent(orcaPage), { timeout: 5_000 })
        .toMatch(/for ?shortcuts|Try ?"|^\s*[❯>]\s*$/m)
      await expect(composer).toBeVisible({ timeout: 5_000 })
    }).toPass({ timeout: 180_000, intervals: [2_000] })
    await record(`composer ready after ${interventionKind}`)
    await orcaPage.screenshot({ path: testInfo.outputPath('02-composer.png') })
    annotate('trust-card', interventionKind)
    expect(sawTrust).toBe(true)

    // CL-02: one turn, one reply.
    await composer.fill(FIRST_PROMPT)
    await composer.press('Enter')
    await expect(chat.getByText(/^(CLAUDE-LIVE-ONE|Login expired.*)$/).first()).toBeVisible({
      timeout: 240_000
    })
    await expect(chat).toHaveAttribute('data-native-chat-working', 'false', { timeout: 60_000 })
    await expect(chat.getByText('CLAUDE-LIVE-ONE', { exact: true }).first()).toBeVisible()
    await record('first answer')
    await orcaPage.screenshot({ path: testInfo.outputPath('03-first-answer.png') })
    const chatAfterFirst = await chat.innerText()
    expect((chatAfterFirst.match(/Remember the code word HERON/g) ?? []).length).toBe(1)

    // CL-03: the Effort pill is a radio list; a pick routes Claude's own /effort command.
    const optionsPill = chat
      .getByRole('button', { name: /Effort|Reasoning|Session options/ })
      .first()
    await expect(optionsPill).toBeVisible({ timeout: 30_000 })
    const rows = orcaPage.getByRole('menuitemradio')
    await expect(async () => {
      await orcaPage.keyboard.press('Escape')
      await optionsPill.click()
      await expect.poll(() => rows.count(), { timeout: 5_000 }).toBeGreaterThan(1)
    }).toPass({ timeout: 90_000, intervals: [3_000] })
    const efforts = await rows.evaluateAll((items) =>
      items.map((row) => ({
        text: row.textContent ?? '',
        checked:
          row.getAttribute('aria-checked') === 'true' ||
          row.getAttribute('data-state') === 'checked'
      }))
    )
    annotate('efforts', efforts.map((row) => `${row.checked ? '●' : '○'} ${row.text}`).join(' | '))
    await orcaPage.screenshot({ path: testInfo.outputPath('04-effort-menu.png') })
    expect(efforts.map((row) => row.text).join('\n')).not.toContain('Choose in agent picker')
    const target = efforts.some((row) => row.checked && /^High$/.test(row.text.trim()))
      ? 'Medium'
      : 'High'
    for (const level of [target, target === 'High' ? 'Medium' : 'High']) {
      if (level !== target) {
        await optionsPill.click()
      }
      await rows
        .filter({ hasText: new RegExp(`^${level}$`) })
        .first()
        .click()
      annotate('picked-effort', level)
      await expect
        .poll(() => getTerminalContent(orcaPage), { timeout: 60_000, intervals: [1_000] })
        .toMatch(new RegExp(`Set effort level to ${level.toLowerCase()}`, 'i'))
      await record(`after effort pick ${level}`)
    }
    await orcaPage.screenshot({ path: testInfo.outputPath('05-after-effort.png') })
    annotate('options-pill', await optionsPill.innerText().catch(() => '?'))

    // CL-04: the Model pill lists real choices (not switched here: a switch may confirm).
    const modelPill = chat.getByRole('button', { name: /Model/ }).first()
    await expect(modelPill).toBeVisible({ timeout: 30_000 })
    await expect(async () => {
      await orcaPage.keyboard.press('Escape')
      await modelPill.click()
      await expect.poll(() => rows.count(), { timeout: 5_000 }).toBeGreaterThan(1)
    }).toPass({ timeout: 60_000, intervals: [3_000] })
    annotate('models', (await rows.allInnerTexts()).join(' | '))
    await orcaPage.screenshot({ path: testInfo.outputPath('06-model-menu.png') })
    await orcaPage.keyboard.press('Escape')

    // CL-05: the agent exits (/exit in its own terminal); the conversation stays and
    // Resume continues the same Claude session.
    await orcaPage.getByRole('radio', { name: 'Terminal', exact: true }).first().click()
    await orcaPage.waitForTimeout(1_000)
    await focusActiveTerminalInput(orcaPage)
    await orcaPage.keyboard.type('/exit')
    await orcaPage.waitForTimeout(500)
    await orcaPage.keyboard.press('Enter')
    await orcaPage.waitForTimeout(500)
    await orcaPage.keyboard.press('Enter')
    await orcaPage.getByRole('radio', { name: 'Chat', exact: true }).first().click()
    const exited = orcaPage.locator('[data-native-chat-agent-exited="true"]').first()
    await expect(exited).toBeVisible({ timeout: 90_000 })
    await record('agent exited')
    await orcaPage.screenshot({ path: testInfo.outputPath('07-exited-notice.png') })
    const exitedText = await exited.innerText()
    annotate('exited-notice', exitedText)
    // History is kept.
    await expect(chat.getByText('CLAUDE-LIVE-ONE').first()).toBeVisible()
    const resume = exited.getByRole('button', { name: /Resume/i }).first()
    await expect(resume).toBeVisible()
    await resume.click()
    const chatAfterResume = orcaPage.locator('[data-native-chat-root="true"]:visible').first()
    const composerAfterResume = chatAfterResume.locator('textarea').first()
    await expect(composerAfterResume).toBeVisible({ timeout: 120_000 })
    await record('resumed')
    await orcaPage.screenshot({ path: testInfo.outputPath('08-resumed.png') })
    await composerAfterResume.fill(SECOND_PROMPT)
    await composerAfterResume.press('Enter')
    await expect
      .poll(() => getTerminalContent(orcaPage), { timeout: 240_000, intervals: [2_000] })
      .toMatch(/CLAUDE-LIVE-TWO\s+HERON/)
    await expect(
      chatAfterResume.getByText('CLAUDE-LIVE-TWO HERON', { exact: true }).first()
    ).toBeVisible()
    await record('second answer on the resumed session')
    await orcaPage.screenshot({ path: testInfo.outputPath('09-second-answer.png') })
    annotate('chat-text', (await chatAfterResume.innerText()).slice(0, 2500))
  } finally {
    writeFileSync(testInfo.outputPath('timeline.log'), `${timeline.join('\n\n')}\n`)
    await testInfo.attach('timeline', { body: timeline.join('\n\n'), contentType: 'text/plain' })
    rmSync(claudeDir, { recursive: true, force: true })
    rmSync(path.join(isolatedHome, '.claude.json'), { force: true })
    rmSync(LIVE_BIN_DIR, { recursive: true, force: true })
  }
})
