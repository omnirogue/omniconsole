import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { getTerminalContent } from './helpers/terminal'

/**
 * Live check of session prep against REAL providers: a person types "create sessions for …" into a
 * Claude chat; the message must not reach that agent; the host plans, prepares (read-only Claude),
 * checks (JEV) and launches the items as new sessions. Opt-in, never in CI:
 *
 *   OMNI_LIVE_SESSION_PREP=1 TYPESAFE_API_KEY=… [ANTHROPIC_BASE_URL=… ANTHROPIC_AUTH_TOKEN=…] \
 *     pnpm exec playwright test tests/e2e/session-prep-live.spec.ts --project electron-headless
 *
 * Claude auth comes from ANTHROPIC_* in the runner's environment (e.g. a local auth proxy), since
 * the harness home is isolated. Evidence (batch record, screenshots) lands in the test output dir.
 */
const LIVE = process.env.OMNI_LIVE_SESSION_PREP === '1'
const REQUEST =
  'create sessions for: add a CONTRIBUTING.md that explains how to set up and run this repository; and add an .editorconfig that uses 2-space indentation for every file type'

test.skip(!LIVE, 'set OMNI_LIVE_SESSION_PREP=1 to run the live session prep check')
// Why PATH: the harness launches with a minimal PATH, so without the CLI's folder the app finds
// "No enabled agents" (same reason the live Codex spec prepends its binary's folder).
const CLAUDE_BIN_DIR = process.env.OMNI_LIVE_CLAUDE_DIR ?? path.join(os.homedir(), '.local', 'bin')
test.use({
  launchEnv: {
    PATH: `${CLAUDE_BIN_DIR}:${process.env.PATH ?? ''}`,
    ...Object.fromEntries(
      ['TYPESAFE_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']
        .filter((name) => process.env[name])
        .map((name) => [name, process.env[name]!])
    )
  }
})
test.setTimeout(20 * 60_000)

type BatchRecord = {
  id: string
  state: string
  request: string
  items: { index: number; state: string; note?: string; verdicts?: unknown[]; launched?: unknown }[]
}

test('real providers: a session request becomes prepared, checked and launched sessions', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  const isolatedHome = await electronApp.evaluate(({ app }) => app.getPath('home'))
  if (isolatedHome === os.homedir()) {
    throw new Error('refusing to seed agent state into the developer home')
  }
  // Why: a first-run Claude TUI would stop on onboarding in the disposable home.
  writeFileSync(
    path.join(isolatedHome, '.claude.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      theme: 'dark',
      bypassPermissionsModeAccepted: true
    })
  )
  mkdirSync(path.join(isolatedHome, '.claude'), { recursive: true })
  const userData = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const batchesFile = path.join(userData, 'session-prep', 'batches.json')
  const readBatches = (): BatchRecord[] =>
    existsSync(batchesFile) ? (JSON.parse(readFileSync(batchesFile, 'utf8')).batches ?? []) : []

  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  // Why env, not a copied login: Claude refresh tokens rotate, so a copied credential can sign
  // the developer's own profile out. Auth rides ANTHROPIC_* (e.g. a local auth proxy) instead.
  const claudeEnv = Object.fromEntries(
    ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']
      .filter((name) => process.env[name])
      .map((name) => [name, process.env[name]!])
  )
  await orcaPage.evaluate(async (env) => {
    await window.__store!.getState().updateSettings({
      defaultTuiAgent: 'claude',
      agentDefaultEnv: { claude: env },
      experimentalNativeChat: true,
      openAgentTabsInChatByDefault: true,
      experimentalStructuredNativeChat: false
    })
  }, claudeEnv)

  // Why the store and not the New tab menu: the menu lists an agent only after its account usage
  // is verified, which a disposable home cannot show; this is what the menu does underneath.
  const tabsBefore = await orcaPage.locator('[data-testid="sortable-tab"]').count()
  await orcaPage.evaluate(
    (claudePath) => {
      const state = window.__store!.getState()
      state.createTab(state.activeWorktreeId!, undefined, undefined, {
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
    },
    path.join(CLAUDE_BIN_DIR, 'claude')
  )
  await expect
    .poll(() => orcaPage.locator('[data-testid="sortable-tab"]').count(), { timeout: 60_000 })
    .toBeGreaterThan(tabsBefore)

  const chat = orcaPage.locator('[data-native-chat-root="true"]:visible').first()
  await expect(chat).toBeVisible({ timeout: 120_000 })
  const intervention = orcaPage.locator('[data-native-chat-startup-intervention]').first()
  const composer = chat.locator('textarea').first()
  await expect(async () => {
    if (await intervention.isVisible()) {
      await intervention.getByRole('button').first().click()
    }
    await expect(composer).toBeVisible({ timeout: 5_000 })
  }).toPass({ timeout: 180_000, intervals: [2_000] })
  await orcaPage.screenshot({ path: testInfo.outputPath('01-source-chat.png') })

  await composer.fill(REQUEST)
  await composer.press('Enter')

  // Taken by the host, not sent: the draft clears and the status line appears.
  await expect(composer).toHaveValue('', { timeout: 10_000 })
  const status = chat.locator('[data-session-prep-status]').first()
  await expect(status).toBeVisible({ timeout: 15_000 })
  await orcaPage.screenshot({ path: testInfo.outputPath('02-status-line.png') })

  let batch: BatchRecord | undefined
  await expect
    .poll(
      () => {
        batch = readBatches().find((candidate) => candidate.request.includes('CONTRIBUTING.md'))
        return batch?.state ?? 'missing'
      },
      { timeout: 18 * 60_000, intervals: [5_000] }
    )
    .toMatch(/^(done|failed|cancelled)$/)
  writeFileSync(testInfo.outputPath('batch.json'), JSON.stringify(batch, null, 1))
  await orcaPage.screenshot({ path: testInfo.outputPath('03-after-launch.png') })
  expect(batch!.state).toBe('done')
  const launched = batch!.items.filter((item) => item.state === 'launched')
  expect(launched.length).toBeGreaterThanOrEqual(2)

  // The source agent never saw the request.
  expect(await getTerminalContent(orcaPage).catch(() => '')).not.toContain('CONTRIBUTING.md')

  // Every launched item's workspace shows up in the app (new workspaces for code-changing items).
  const launchedIds = launched
    .map((item) => (item.launched as { worktreeId?: string } | undefined)?.worktreeId)
    .filter((id): id is string => Boolean(id))
  await expect
    .poll(
      () =>
        orcaPage.evaluate((ids) => {
          const state = window.__store!.getState() as never as {
            worktreesByRepo: Record<string, { id: string }[]>
          }
          const known = new Set(
            Object.values(state.worktreesByRepo)
              .flat()
              .map((w) => w.id)
          )
          return ids.filter((id) => known.has(id)).length
        }, launchedIds),
      { timeout: 60_000, intervals: [2_000] }
    )
    .toBe(launchedIds.length)
  writeFileSync(
    testInfo.outputPath('launched-worktrees.json'),
    JSON.stringify(launchedIds, null, 1)
  )
})
