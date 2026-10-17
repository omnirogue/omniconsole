/**
 * A paired computer shows the owner's sessions as the owner does: under the owner's name, working
 * or done as they are there, and in or out of Archived as the owner has them. Archiving or unarchiving on the paired computer
 * changes it on the owner, which is the one place the placement lives.
 */
import type { Locator, Page } from '@stablyai/playwright-test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, test } from './helpers/orca-app'
import { getGoldenStubAgentLaunchEnv } from './helpers/golden-stub-agent'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient
} from './helpers/paired-electron-client'
import {
  acceptPrompt,
  finishTurn,
  runCli,
  startStubConversation,
  userDataPathOf
} from './helpers/stub-claude-conversation'

test.use({
  launchEnv: {
    ...getGoldenStubAgentLaunchEnv(),
    GOLDEN_STUB_SHOW_PID: '1',
    GOLDEN_STUB_AGENT_TITLE: 'claude'
  }
})

const NAME = 'Paired archive probe'
const SHOWN_ROW =
  '[data-session-group]:not([data-session-group-kind="archived"]) [data-session-row]'
const ARCHIVED_ROW = '[data-session-group-kind="archived"] [data-session-row]'

/** Unfolds the list's groups (a finished session sits in a folded Done group). */
async function unfoldSessionGroups(page: Page): Promise<void> {
  const folded = page.locator(
    '[data-session-group] button[aria-expanded="false"][aria-label^="Expand "]'
  )
  for (let round = 0; round < 6 && (await folded.count()) > 0; round += 1) {
    await folded.first().click()
  }
}

/** Keyboard press: the paired window's narrow list overlaps a row's trailing quick actions. */
async function press(button: Locator): Promise<void> {
  await button.focus()
  await button.press('Enter')
}

function shownRow(page: Page) {
  return page.locator(SHOWN_ROW).filter({ hasText: NAME })
}

function archivedRow(page: Page) {
  return page.locator(ARCHIVED_ROW).filter({ hasText: NAME })
}

/** The list group the probe's row sits in (Working, Done, …); null while it is not shown. */
async function groupOf(page: Page): Promise<string | null> {
  await unfoldSessionGroups(page)
  const row = shownRow(page)
  return (await row.count()) === 1
    ? await row.evaluate((element) =>
        element.closest('[data-session-group]')!.getAttribute('aria-label')
      )
    : null
}

test('a paired computer mirrors the owner name, state and archive, and archives on the owner', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  test.setTimeout(300_000)
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-paired-archive-'))
  try {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    const userDataPath = await userDataPathOf(electronApp)
    const probe = await startStubConversation(orcaPage, userDataPath, NAME)
    const transcript = { sessionId: randomUUID(), path: path.join(scratch, 'probe.jsonl') }
    writeFileSync(transcript.path, '')
    await finishTurn(electronApp, probe, transcript, {
      prompt: 'Check the parser.',
      reply: 'The parser is fine.',
      at: Date.now() - 5_000
    })

    const offer = await createRuntimeDesktopPairingOffer(orcaPage)
    const client = await launchPairedElectronClient(offer, testInfo, 'archive-viewer')
    const viewer = client.page
    await expect
      .poll(
        () =>
          viewer.evaluate(
            (id) =>
              window.__store
                ?.getState()
                .allWorktrees()
                .some((worktree) => worktree.id === id) ?? false,
            probe.worktreeId
          ),
        { timeout: 60_000 }
      )
      .toBe(true)
    for (const page of [orcaPage, viewer]) {
      await page.getByRole('button', { name: 'Sessions', exact: true }).click()
    }
    // Home shows this computer's sessions only; the Globe adds the paired ones.
    await viewer
      .getByRole('group', { name: 'Sessions from' })
      .getByRole('button', { name: /^Paired runtimes/ })
      .click()

    // The owner's rename reaches the paired list, not the agent's terminal title.
    await expect
      .poll(
        async () => {
          await unfoldSessionGroups(viewer)
          return shownRow(viewer).count()
        },
        { timeout: 30_000 }
      )
      .toBe(1)
    await expect(shownRow(orcaPage)).toHaveCount(1)

    // Working on the owner: working on the paired computer too, then done on both.
    const doneGroup = await groupOf(orcaPage)
    expect(doneGroup).not.toBeNull()
    await expect.poll(() => groupOf(viewer), { timeout: 30_000 }).toBe(doneGroup)
    await acceptPrompt(electronApp, probe, transcript, 'Check the lexer.')
    await expect.poll(() => groupOf(orcaPage), { timeout: 15_000 }).not.toBe(doneGroup)
    const workingGroup = await groupOf(orcaPage)
    expect(workingGroup).not.toBeNull()
    await expect.poll(() => groupOf(viewer), { timeout: 30_000 }).toBe(workingGroup)
    await finishTurn(electronApp, probe, transcript, {
      prompt: 'Check the lexer.',
      reply: 'The lexer is fine.',
      at: Date.now()
    })
    await expect.poll(() => groupOf(orcaPage), { timeout: 15_000 }).toBe(doneGroup)
    await expect.poll(() => groupOf(viewer), { timeout: 30_000 }).toBe(doneGroup)

    // Archived on the owner: archived on the paired computer too.
    const archived = runCli(userDataPath, ['session', 'archive', '--pane', probe.paneKey, '--json'])
    expect(archived.status, archived.stdout + archived.stderr).toBe(0)
    await expect(shownRow(viewer)).toHaveCount(0, { timeout: 30_000 })
    await viewer.getByRole('button', { name: /^Show archived/ }).click()
    await expect
      .poll(
        async () => {
          await unfoldSessionGroups(viewer)
          return archivedRow(viewer).count()
        },
        { timeout: 15_000 }
      )
      .toBe(1)

    // Unarchived on the paired computer: back on the owner's list, then on this one.
    await press(viewer.getByRole('button', { name: `Unarchive ${NAME}`, exact: true }))
    await expect(shownRow(orcaPage)).toHaveCount(1, { timeout: 30_000 })
    await expect
      .poll(
        async () => {
          await unfoldSessionGroups(viewer)
          return shownRow(viewer).count()
        },
        { timeout: 30_000 }
      )
      .toBe(1)

    // Archived on the paired computer: gone from the owner's list.
    await press(viewer.getByRole('button', { name: `Archive ${NAME}`, exact: true }))
    await expect(shownRow(orcaPage)).toHaveCount(0, { timeout: 30_000 })
    await expect(shownRow(viewer)).toHaveCount(0, { timeout: 30_000 })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
