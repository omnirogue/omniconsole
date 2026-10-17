import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { WorkspaceSessionState } from '../../src/shared/workspace-session-state-types'
import { DEFAULT_LOCAL_ORCA_PROFILE_ID } from '../../src/shared/omni-profiles'
import { toWebTerminalSurfaceTabId } from '../../src/shared/terminal-surface-id'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import {
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import {
  selectPairedWorktreeGroup,
  waitForPairedWorktreeId
} from './helpers/client-hosted-browser-fixture'

// The owner has a completed checkpoint but no process. Revealing its paired
// view must stay passive; its explicit Resume button must wake that exact pane.
test('keeps a completed paired session passive until Resume is clicked', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(180_000)
  const host = await launchHeadlessPairedRuntimeHost({ pinnedServePort: true })
  let client: PairedElectronClient | null = null
  const tabId = randomUUID()
  const leafId = randomUUID()
  const providerSessionId = randomUUID()
  const paneKey = `${tabId}:${leafId}`
  try {
    const added = await host.client.call<{ repo: { id: string } }>('repo.add', {
      path: testRepoPath,
      kind: 'git'
    })
    const listed = await host.client.call<{ worktrees: { id: string; path: string }[] }>(
      'worktree.list',
      { repo: `id:${added.result.repo.id}` }
    )
    const worktree = listed.result.worktrees.find((candidate) => candidate.path === testRepoPath)
    if (!worktree) {
      throw new Error('Seeded host checkout missing')
    }
    const isolatedHome = await host.app.evaluate(({ app }) => app.getPath('home'))
    const sessionsDir = path.join(isolatedHome, '.codex', 'sessions', '2026', '10', '03')
    mkdirSync(sessionsDir, { recursive: true })
    const transcriptPath = path.join(sessionsDir, `rollout-${providerSessionId}.jsonl`)
    writeFileSync(
      transcriptPath,
      `${JSON.stringify({ type: 'session_meta', payload: { id: providerSessionId, cwd: testRepoPath } })}\n`
    )
    await host.restartServeProcess({
      betweenProcesses: () => {
        const dataPath = path.join(
          host.userDataDir,
          'profiles',
          DEFAULT_LOCAL_ORCA_PROFILE_ID,
          'omni-data.json'
        )
        const data = JSON.parse(readFileSync(dataPath, 'utf8')) as {
          workspaceSession: WorkspaceSessionState
        }
        const session = data.workspaceSession
        const now = Date.now()
        session.activeWorktreeId = worktree.id
        session.activeTabId = tabId
        session.activeTabIdByWorktree = { ...session.activeTabIdByWorktree, [worktree.id]: tabId }
        session.tabsByWorktree ??= {}
        session.tabsByWorktree[worktree.id] = [
          {
            id: tabId,
            worktreeId: worktree.id,
            title: 'Completed finite diagnostic',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: now,
            ptyId: `serve-completed-${tabId}`
          }
        ]
        session.terminalLayoutsByTabId ??= {}
        session.terminalLayoutsByTabId[tabId] = {
          root: { type: 'leaf', leafId },
          activeLeafId: leafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leafId]: `serve-completed-${tabId}` }
        }
        session.sleepingAgentSessionsByPaneKey = {
          [paneKey]: {
            paneKey,
            tabId,
            worktreeId: worktree.id,
            agent: 'codex',
            providerSession: { key: 'session_id', id: providerSessionId, transcriptPath },
            prompt: 'Finite diagnostic already completed',
            state: 'done',
            origin: 'live',
            capturedAt: now,
            updatedAt: now,
            lastAssistantMessage: 'Diagnostic complete. No further work.',
            // Keep any resume command hermetic; no real provider is authorized by the fixture.
            launchConfig: { agentCommand: 'echo', agentArgs: '', agentEnv: {} }
          }
        }
        writeFileSync(dataPath, `${JSON.stringify(data, null, 2)}\n`)
      }
    })
    client = await launchPairedElectronClient(host.offer, testInfo, 'Completed session viewer')
    const page = client.page
    const worktreeId = await waitForPairedWorktreeId(page, testRepoPath)
    await selectPairedWorktreeGroup(page, client.environmentId, worktreeId)
    const webTabId = toWebTerminalSurfaceTabId(tabId)
    const tab = page.locator(`[data-tab-id="${webTabId}"]`)
    const pane = page.locator(`[data-terminal-tab-id="${webTabId}"][data-terminal-layout-leaf-ids]`)
    await expect(tab).toBeVisible()
    await expect(tab).toHaveAttribute('data-active', 'true')
    await expect(pane).toBeVisible()
    // Wait for the transport's completed probe sequence, not merely React mount.
    // A ready owner is the regression; the held banner proves the owner
    // answered the passive probe with its exact completed checkpoint.
    await expect
      .poll(
        async () => {
          const snapshot = await host.client.call<{
            tabs: { parentTabId?: string; status?: string }[]
          }>('session.tabs.list', { worktree: `id:${worktreeId}` })
          const ready = snapshot.result.tabs.some(
            (candidate) => candidate.parentTabId === tabId && candidate.status === 'ready'
          )
          return (
            ready ||
            (await pane
              .locator('[data-terminal-automatic-activation-hold="completed"]')
              .isVisible())
          )
        },
        { timeout: 30_000, message: 'Passive transport did not finish its initial handle probe' }
      )
      .toBe(true)
    const passiveScreenshot = testInfo.outputPath('completed-passive-before-click.png')
    await page.screenshot({ path: passiveScreenshot })
    await testInfo.attach('completed-passive-before-click', {
      path: passiveScreenshot,
      contentType: 'image/png'
    })
    const pending = await host.client.call<{
      tabs: { parentTabId?: string; status?: string; terminal?: string | null }[]
    }>('session.tabs.list', { worktree: `id:${worktreeId}` })
    expect(pending.result.tabs.find((candidate) => candidate.parentTabId === tabId)).toMatchObject({
      status: 'pending-handle',
      terminal: null,
      automaticActivationHold: 'completed'
    })
    await expect(pane).toContainText('Session completed')
    await expect(pane).not.toContainText('Reconnecting to remote runtime')
    await expect(pane).not.toContainText(providerSessionId)

    await pane.getByRole('button', { name: 'Resume', exact: true }).click()

    let terminalHandle: string | null = null
    await expect
      .poll(async () => {
        const awakened = await host.client.call<{
          tabs: {
            parentTabId?: string
            leafId?: string
            status?: string
            terminal?: string | null
          }[]
        }>('session.tabs.list', { worktree: `id:${worktreeId}` })
        const owned = awakened.result.tabs.find((candidate) => candidate.parentTabId === tabId)
        terminalHandle = owned?.terminal ?? null
        return owned ? { leafId: owned.leafId, status: owned.status } : null
      })
      .toEqual({ leafId, status: 'ready' })
    if (!terminalHandle) {
      throw new Error('Explicit Resume did not materialize the owner terminal')
    }
    await expect(pane.locator('[data-terminal-automatic-activation-hold]')).toHaveCount(0)
    await expect(pane.locator('.xterm-screen')).toBeVisible()
    await page.evaluate((id) => {
      const terminal = window.__paneManagers?.get(id)?.getActivePane()?.terminal
      if (!terminal) {
        throw new Error('Revealed terminal missing')
      }
      terminal.options.screenReaderMode = true
      terminal.refresh(0, terminal.rows - 1)
    }, webTabId)
    const marker = `EXPLICIT_WAKE_${providerSessionId}`
    await host.client.call('terminal.send', {
      terminal: terminalHandle,
      text: `echo ${marker}`,
      enter: true
    })
    await expect(pane.locator('.xterm-accessibility-tree')).toContainText(marker, {
      timeout: 30_000
    })
    const wakeScreenshot = testInfo.outputPath('completed-explicit-wake-after-click.png')
    await page.screenshot({ path: wakeScreenshot })
    await testInfo.attach('completed-explicit-wake-after-click', {
      path: wakeScreenshot,
      contentType: 'image/png'
    })
  } finally {
    await client?.dispose()
    await host.dispose()
  }
})
