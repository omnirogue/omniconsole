import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { FREEFORM_NOT_AN_APPROVAL } from '../../src/main/session-manage/session-manage-freeform'
import { sessionManageQuestionMarker } from '../../src/shared/session-manage-types'
import { test, expect } from './helpers/orca-app'
import { getGoldenStubAgentLaunchEnv } from './helpers/golden-stub-agent'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { getTerminalContent, waitForTerminalOutput } from './helpers/terminal'
import {
  acceptPrompt,
  finishTurn,
  runCli,
  runCliAsync,
  startStubConversation,
  userDataPathOf,
  type Conversation,
  type Transcript
} from './helpers/stub-claude-conversation'

/**
 * The `omni session` / `omni folder` commands: a manager conversation drives three stub
 * conversations (A, B, C) through the real CLI against the running app's own runtime.
 */

test.use({
  launchEnv: {
    ...getGoldenStubAgentLaunchEnv(),
    GOLDEN_STUB_RECEIPTS: '1',
    GOLDEN_STUB_SHOW_PID: '1',
    GOLDEN_STUB_AGENT_TITLE: 'claude'
  }
})

/** Switches the active tab to the given pane's tab, so terminal-content reads target that pane. */
async function switchToPane(page: Page, paneKey: string): Promise<void> {
  const tabId = paneKey.split(':')[0]!
  await page.evaluate((tabId) => {
    const store = window.__store!
    const state = store.getState()
    const worktreeId = state.activeWorktreeId
    if (worktreeId) {
      state.setActiveTab(tabId)
      state.setActiveTabType('terminal')
    }
  }, tabId)
}

/** The stub's receipt lines (`RECEIPT n: …`) as currently rendered on screen. */
async function stubReceipts(page: Page): Promise<string> {
  const screen = await getTerminalContent(page, 20_000)
  return [...screen.matchAll(/RECEIPT \d+: [\w/ -]*/g)]
    .map((match) => match[0].trimEnd())
    .join('\n')
}

function readAuditLines(userDataPath: string): Record<string, unknown>[] {
  const auditPath = path.join(userDataPath, 'session-actions.jsonl')
  try {
    return readFileSync(auditPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  } catch {
    return []
  }
}

test.describe('AI manages sessions', () => {
  let scratchDir: string
  test.beforeEach(() => {
    scratchDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-session-manage-'))
  })
  test.afterEach(() => {
    rmSync(scratchDir, { recursive: true, force: true })
  })

  function transcriptFor(): Transcript {
    const sessionId = randomUUID()
    const transcriptPath = path.join(scratchDir, `${sessionId}.jsonl`)
    writeFileSync(transcriptPath, '')
    return { sessionId, path: transcriptPath }
  }

  /** SETUP: three stub conversations A idle, B waiting-for-yes, C mid-turn (working). */
  async function startABC(
    electronApp: ElectronApplication,
    orcaPage: Page
  ): Promise<{ a: Conversation; b: Conversation; c: Conversation }> {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    const sessionsTab = orcaPage.getByRole('button', { name: 'Sessions', exact: true })
    if (await sessionsTab.isVisible().catch(() => false)) {
      await sessionsTab.click()
    }
    const userDataPath = await userDataPathOf(electronApp)

    const a = {
      ...(await startStubConversation(orcaPage, userDataPath, 'Conversation A')),
      transcript: transcriptFor()
    }
    await finishTurn(electronApp, a, a.transcript, {
      prompt: 'Look over the parser module.',
      reply: 'The parser module looks fine, no changes needed.',
      at: Date.now() - 20_000
    })

    const b = {
      ...(await startStubConversation(orcaPage, userDataPath, 'Conversation B')),
      transcript: transcriptFor()
    }
    await finishTurn(electronApp, b, b.transcript, {
      prompt: 'Review the docs for the new command.',
      reply: 'I reviewed the docs and found two stale examples. Should I update the docs?',
      at: Date.now() - 10_000
    })

    const c = {
      ...(await startStubConversation(orcaPage, userDataPath, 'Conversation C')),
      transcript: transcriptFor()
    }
    await acceptPrompt(electronApp, c, c.transcript, 'Run the full test suite and report failures.')

    return { a, b, c }
  }

  test('session list --json shows the three states, matching the sidebar', async ({
    electronApp,
    orcaPage
  }) => {
    const { a, b, c } = await startABC(electronApp, orcaPage)
    const userDataPath = await userDataPathOf(electronApp)

    const result = runCli(userDataPath, ['session', 'list', '--json'])
    expect(result.status).toBe(0)
    const sessions = (result.json as { sessions: Record<string, unknown>[] }).sessions
    const byTitle = (title: string) => sessions.find((s) => s.title === title)

    expect(byTitle('Conversation A')?.state).toBe('idle')
    expect(byTitle('Conversation B')?.state).toBe('waiting-for-yes')
    expect(byTitle('Conversation C')?.state).toBe('working')

    // The sidebar DOM agrees: all three sessions the CLI reported are visible rows.
    await switchToPane(orcaPage, a.paneKey)
    const rowA = orcaPage.locator('[data-session-row]').filter({ hasText: 'Conversation A' })
    const rowB = orcaPage.locator('[data-session-row]').filter({ hasText: 'Conversation B' })
    const rowC = orcaPage.locator('[data-session-row]').filter({ hasText: 'Conversation C' })
    await expect(rowA).toBeVisible()
    await expect(rowB).toBeVisible()
    await expect(rowC).toBeVisible()
    void b
    void c
  })

  test('session continue --pane B --yes delivers only B its own proposal, once', async ({
    electronApp,
    orcaPage
  }) => {
    const { a, b, c } = await startABC(electronApp, orcaPage)
    const userDataPath = await userDataPathOf(electronApp)

    const result = runCli(userDataPath, [
      'session',
      'continue',
      '--pane',
      b.paneKey,
      '--yes',
      '--json'
    ])
    expect(result.status).toBe(0)

    await switchToPane(orcaPage, b.paneKey)
    await waitForTerminalOutput(orcaPage, '[from', 15_000)
    const bScreen = await getTerminalContent(orcaPage)
    expect(bScreen).toContain('[from')
    expect(bScreen).toMatch(/update the docs/i)

    // Neither A nor C received anything: their receipts stay empty.
    await switchToPane(orcaPage, a.paneKey)
    expect(await stubReceipts(orcaPage)).toBe('')
    await switchToPane(orcaPage, c.paneKey)
    expect(await stubReceipts(orcaPage)).toBe('')
  })

  test('session continue --prompt "deploy to production" hits the hard stop and A gets nothing', async ({
    electronApp,
    orcaPage
  }) => {
    const { a } = await startABC(electronApp, orcaPage)
    const userDataPath = await userDataPathOf(electronApp)

    const result = runCli(userDataPath, [
      'session',
      'continue',
      '--pane',
      a.paneKey,
      '--prompt',
      'deploy to production',
      '--json'
    ])
    expect(result.status).not.toBe(0)
    expect(result.stdout + result.stderr).toMatch(/hard stop/i)
    expect(result.stdout + result.stderr).toMatch(/deploy/i)

    await switchToPane(orcaPage, a.paneKey)
    expect(await stubReceipts(orcaPage)).toBe('')
  })

  test('session ask --pane A --question returns the reply from A’s next Stop', async ({
    electronApp,
    orcaPage
  }) => {
    const { a } = await startABC(electronApp, orcaPage)
    const userDataPath = await userDataPathOf(electronApp)
    const question = 'What files have you changed so far?'

    const cliDone = runCliAsync(userDataPath, [
      'session',
      'ask',
      '--pane',
      a.paneKey,
      '--question',
      question,
      '--timeout-ms',
      '20000',
      '--json'
    ])

    // Deliver A's next turn as its answer to the queued question.
    await switchToPane(orcaPage, a.paneKey)
    // Why the receipt, not the question text: the text sits in A's composer while the CLI still
    // waits to press Enter, and a hook report in that window revokes its write fence, so the
    // question is left unsent. A real agent reports UserPromptSubmit only after Enter. The stub
    // submits the pasted note on its newline and the question itself on that Enter.
    await waitForTerminalOutput(orcaPage, `RECEIPT 2: ${question}`, 15_000)
    // The delivered prompt carries the "answer only" marker with this question's own request id;
    // the Stop hook's prompt must carry it for the CLI to tie the reply to this question. The
    // acting session here is the plain local CLI, so the marker names it that.
    const requestId = /\[Question (q-[0-9a-f]{8}) from omni CLI/.exec(
      await getTerminalContent(orcaPage, 20_000)
    )?.[1]
    expect(requestId).toBeTruthy()
    // What A received, as `omni session ask` sends it: the marker, the not-an-approval note, then
    // the question. The reply is tied to the question only if the recorded prompt is a prefix of it.
    const sent = `${sessionManageQuestionMarker('omni CLI', requestId!)}${FREEFORM_NOT_AN_APPROVAL}\n${question}`
    await finishTurn(electronApp, a, a.transcript, {
      prompt: sent,
      reply: 'I changed parser.ts and parser.test.ts.',
      at: Date.now()
    })

    const result = await cliDone
    expect(result.status).toBe(0)
    const parsed = result.json as { outcome: string; reply: string }
    expect(parsed.outcome).toBe('answered')
    expect(parsed.reply).toContain('parser.ts')
  })

  test('folder create, session move/rename/archive with --dry-run, all shown in the sidebar DOM', async ({
    electronApp,
    orcaPage
  }) => {
    const { a, c } = await startABC(electronApp, orcaPage)
    const userDataPath = await userDataPathOf(electronApp)

    const created = runCli(userDataPath, ['folder', 'create', '--name', 'Sales', '--json'])
    expect(created.status).toBe(0)

    // A CLI move must say why (recorded with the change); only a --dry-run is exempt.
    const moved = runCli(userDataPath, [
      'session',
      'move',
      '--pane',
      a.paneKey,
      '--folder',
      'Sales',
      '--reason',
      'e2e: file A under Sales',
      '--json'
    ])
    expect(moved.status).toBe(0)
    await switchToPane(orcaPage, a.paneKey)
    const salesGroup = orcaPage.locator('[data-session-group="Sales"], [data-session-group]', {
      hasText: 'Sales'
    })
    await expect(
      salesGroup.locator('[data-session-row]').filter({ hasText: 'Conversation A' })
    ).toBeVisible({ timeout: 15_000 })

    const renamed = runCli(userDataPath, [
      'session',
      'rename',
      '--pane',
      a.paneKey,
      '--title',
      'Renamed A',
      '--json'
    ])
    expect(renamed.status).toBe(0)
    await expect(
      orcaPage.locator('[data-session-row]').filter({ hasText: 'Renamed A' })
    ).toBeVisible({ timeout: 15_000 })

    // Archive C with --dry-run: nothing changes.
    const dryRun = runCli(userDataPath, [
      'session',
      'archive',
      '--pane',
      c.paneKey,
      '--dry-run',
      '--json'
    ])
    expect(dryRun.status).toBe(0)
    await switchToPane(orcaPage, c.paneKey)
    await expect(
      orcaPage.locator('[data-session-group-kind="archived"] [data-session-row]').filter({
        hasText: 'Conversation C'
      })
    ).toHaveCount(0)

    // Real archive: C moves under Archived.
    const archived = runCli(userDataPath, ['session', 'archive', '--pane', c.paneKey, '--json'])
    expect(archived.status).toBe(0)
    const showArchived = orcaPage.getByRole('button', { name: /^Show archived/ })
    if (await showArchived.isVisible().catch(() => false)) {
      await showArchived.click()
    }
    await expect(
      orcaPage.locator('[data-session-group-kind="archived"] [data-session-row]').filter({
        hasText: 'Conversation C'
      })
    ).toBeVisible({ timeout: 15_000 })
  })

  test('each applied action is written to session-actions.jsonl with actor and target', async ({
    electronApp,
    orcaPage
  }) => {
    const { a } = await startABC(electronApp, orcaPage)
    const userDataPath = await userDataPathOf(electronApp)

    const renamed = runCli(userDataPath, [
      'session',
      'rename',
      '--pane',
      a.paneKey,
      '--title',
      'Audited A',
      '--reason',
      'e2e audit check',
      '--json'
    ])
    expect(renamed.status).toBe(0)

    const lines = readAuditLines(userDataPath)
    const entry = lines.find((line) => line.action === 'rename' && line.after === 'Audited A')
    expect(entry).toBeTruthy()
    expect(entry?.actor).toBe('cli')
    expect((entry?.target as { paneKey?: string })?.paneKey).toBe(a.paneKey)
    expect(entry?.reason).toBe('e2e audit check')
  })

  test('session conflicts --json reports two live sessions sharing one worktree', async ({
    electronApp,
    orcaPage
  }) => {
    await startABC(electronApp, orcaPage)
    const userDataPath = await userDataPathOf(electronApp)

    // A and B were both launched into the same active worktree, so they already share it.
    const result = runCli(userDataPath, ['session', 'conflicts', '--json'])
    expect(result.status).toBe(0)
    const parsed = result.json as {
      repos: { sharedWorktrees: { sessions: { title?: string }[] }[] }[]
    }
    const sharedWorktree = parsed.repos
      .flatMap((repo) => repo.sharedWorktrees)
      .find((entry) => entry.sessions.length >= 2)
    expect(sharedWorktree).toBeTruthy()
    const titles = sharedWorktree?.sessions.map((s) => s.title)
    expect(titles).toEqual(expect.arrayContaining(['Conversation A']))
  })
})
