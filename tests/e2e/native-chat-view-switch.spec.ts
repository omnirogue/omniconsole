import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'
import type { GlobalSettings } from '../../src/shared/global-settings-types'

const USER_TEXT = 'Summarise the launch notes for the team'
const ASSISTANT_TEXT = 'Here is a short summary of the launch notes.'
const DRAFT = 'A draft that must survive the switch'

async function enableNativeChat(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const nextSettings = await window.api.settings.set({ experimentalNativeChat: true })
    window.__store?.setState({ settings: nextSettings as GlobalSettings })
  })
}

// Why: hermetic, like native-chat-first-flush-race.spec.ts — seeding the pane's Claude
// provider session drives the same store → chat path a real Claude hook would.
async function seedClaudeSession(
  page: Page,
  args: { paneKey: string; worktreeId: string; sessionId: string; transcriptPath: string }
): Promise<void> {
  await page.evaluate(({ paneKey, worktreeId, sessionId, transcriptPath }) => {
    window.__store
      ?.getState()
      .setAgentStatus(
        paneKey,
        { state: 'working', prompt: 'e2e view switch probe', agentType: 'claude' },
        'Claude',
        undefined,
        { worktreeId },
        { providerSession: { key: 'session_id', id: sessionId, transcriptPath } }
      )
  }, args)
}

async function viewModeOf(page: Page, worktreeId: string, tabId: string): Promise<string | null> {
  return page.evaluate(
    ({ worktreeId, tabId }) =>
      (window.__store?.getState().unifiedTabsByWorktree[worktreeId] ?? []).find(
        (tab) => tab.contentType === 'terminal' && tab.entityId === tabId
      )?.viewMode ?? null,
    { worktreeId, tabId }
  )
}

async function ptyOf(page: Page, tabId: string): Promise<string> {
  return page.evaluate(
    (id) => JSON.stringify(window.__store?.getState().ptyIdsByTabId[id] ?? null),
    tabId
  )
}

function transcript(sessionId: string): string {
  const at = Date.now()
  return [
    {
      sessionId,
      uuid: `${sessionId}-user`,
      timestamp: new Date(at).toISOString(),
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: USER_TEXT }] }
    },
    {
      sessionId,
      uuid: `${sessionId}-assistant`,
      timestamp: new Date(at + 2_000).toISOString(),
      type: 'assistant',
      message: { model: 'claude-opus-4', content: [{ type: 'text', text: ASSISTANT_TEXT }] }
    }
  ]
    .map((line) => JSON.stringify(line))
    .join('\n')
    .concat('\n')
}

test('the Chat / Terminal switch changes only the view of the same session', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)

  const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
  const [tabId] = descriptor.paneKey.split(':')
  const sessionId = `e2e-view-switch-${randomUUID()}`
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-view-switch-'))
  const transcriptPath = path.join(scratch, `${sessionId}.jsonl`)
  writeFileSync(transcriptPath, transcript(sessionId))

  try {
    // Why: on a slower host the PTY attaches after the pane mounts; take the baseline once it exists.
    await expect.poll(() => ptyOf(orcaPage, tabId), { timeout: 30_000 }).toMatch(/^\["/)
    const pty = await ptyOf(orcaPage, tabId)
    await enableNativeChat(orcaPage)
    await seedClaudeSession(orcaPage, {
      paneKey: descriptor.paneKey,
      worktreeId: descriptor.worktreeId,
      sessionId,
      transcriptPath
    })

    const toggle = orcaPage.locator(
      `[data-conversation-work-header][data-conversation-tab-id="${tabId}"] [data-native-chat-switch]`
    )
    await expect(toggle).toBeVisible({ timeout: 15_000 })
    await expect(toggle).toHaveCount(1)
    const strip = orcaPage.locator('[data-hidden-tab-strip-controls]')
    const stripCount = await strip.count()
    await toggle.getByText('Chat', { exact: true }).click()
    await expect.poll(() => viewModeOf(orcaPage, descriptor.worktreeId, tabId)).toBe('chat')
    const chat = orcaPage.locator('[data-native-chat-root="true"]').first()
    await expect(chat).toBeVisible({ timeout: 15_000 })
    await expect(strip).toHaveCount(stripCount)
    await expect(chat.locator('textarea:focus')).toHaveCount(1)
    await expect(orcaPage.getByText(ASSISTANT_TEXT)).toBeVisible({ timeout: 30_000 })
    await chat.locator('textarea').first().fill(DRAFT)
    await orcaPage.screenshot({ path: testInfo.outputPath('01-chat.png') })

    await toggle.getByText('Terminal', { exact: true }).click()
    await expect.poll(() => viewModeOf(orcaPage, descriptor.worktreeId, tabId)).toBe('terminal')
    await expect(chat).toBeHidden()
    await expect(strip).toHaveCount(stripCount)
    await expect(orcaPage.locator('.xterm-helper-textarea:focus')).toHaveCount(1)
    expect(await ptyOf(orcaPage, tabId)).toBe(pty)
    await orcaPage.screenshot({ path: testInfo.outputPath('02-terminal.png') })

    // Why: no real Claude runs in this hermetic PTY, so once the terminal shows its plain shell the
    // app may clear the seeded status, and a plain shell has no switch. A live Claude keeps posting
    // its hook status; re-seed it the same way before switching back through the visible control.
    await seedClaudeSession(orcaPage, {
      paneKey: descriptor.paneKey,
      worktreeId: descriptor.worktreeId,
      sessionId,
      transcriptPath
    })
    await toggle.getByText('Chat', { exact: true }).click({ timeout: 15_000 })
    await expect.poll(() => viewModeOf(orcaPage, descriptor.worktreeId, tabId)).toBe('chat')
    await expect(orcaPage.getByText(ASSISTANT_TEXT)).toBeVisible({ timeout: 15_000 })
    await expect(orcaPage.locator('[data-native-chat-root="true"] textarea').first()).toHaveValue(
      DRAFT
    )
    expect(await ptyOf(orcaPage, tabId)).toBe(pty)
    await orcaPage.screenshot({ path: testInfo.outputPath('03-chat-again.png') })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
