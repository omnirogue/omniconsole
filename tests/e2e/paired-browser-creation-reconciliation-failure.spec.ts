import { writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { RuntimeClient } from '../../src/cli/runtime/client'
import { expect, test } from './helpers/orca-app'
import { readHostBrowserPageIds, readHostTabs } from './helpers/host-session-tabs'
import { openFileExplorer } from './helpers/file-explorer'
import {
  launchHeadlessPairedRuntimeHost,
  type HeadlessPairedRuntimeHost
} from './helpers/headless-paired-runtime-host'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient,
  type RuntimeDesktopPairingOffer
} from './helpers/paired-electron-client'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const FIXTURE_NAME = 'paired-browser-reconcile-failure.html'

type FaultSnapshot = {
  armed: boolean
  capabilityRejectionArmed: boolean
  createdPageId: string | null
  suppressedPageIds: string[]
}

type FaultWindow = Window & {
  __webRuntimeBrowserCreationFault?: {
    arm: () => void
    armCapabilityRejection: () => void
    release: () => boolean
    reset: () => void
    snapshot: () => FaultSnapshot
  }
}

type ClientTabState = {
  browserTabIds: string[]
  browserWorkspaceIds: string[]
  editorTabIds: string[]
  groupIds: string[]
  terminalTabIds: string[]
}

async function readClientTabs(page: Page, worktreeId: string): Promise<ClientTabState> {
  return page.evaluate((targetWorktreeId) => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('Paired client store unavailable')
    }
    const unifiedTabs = state.unifiedTabsByWorktree[targetWorktreeId] ?? []
    return {
      browserTabIds: unifiedTabs
        .filter((tab) => tab.contentType === 'browser')
        .map((tab) => tab.id),
      browserWorkspaceIds: (state.browserTabsByWorktree[targetWorktreeId] ?? []).map(
        (workspace) => workspace.id
      ),
      editorTabIds: unifiedTabs.filter((tab) => tab.contentType === 'editor').map((tab) => tab.id),
      groupIds: (state.groupsByWorktree[targetWorktreeId] ?? []).map((group) => group.id),
      terminalTabIds: unifiedTabs
        .filter((tab) => tab.contentType === 'terminal')
        .map((tab) => tab.id)
    }
  }, worktreeId)
}

async function runReconciliationFailureJourney(args: {
  hostClient: RuntimeClient
  offer: RuntimeDesktopPairingOffer
  repoPath: string
  testInfo: TestInfo
  topology: 'headed' | 'headless'
}): Promise<void> {
  let client: PairedElectronClient | null = null
  try {
    client = await launchPairedElectronClient(
      args.offer,
      args.testInfo,
      `${args.topology} browser reconciliation failure`
    )
    await client.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.show())
    const page = client.page
    const worktreeId = await expect
      .poll(
        () =>
          page.evaluate((repoPath) => {
            const state = window.__store?.getState()
            return state?.allWorktrees().find((worktree) => worktree.path === repoPath)?.id ?? null
          }, args.repoPath),
        { timeout: 60_000, message: 'paired client never received the host worktree' }
      )
      .not.toBeNull()
      .then(() =>
        page.evaluate((repoPath) => {
          const state = window.__store?.getState()
          return state?.allWorktrees().find((worktree) => worktree.path === repoPath)?.id ?? null
        }, args.repoPath)
      )
    if (!worktreeId) {
      throw new Error('Paired client worktree disappeared after discovery')
    }
    await page.evaluate(
      ({ environmentId, worktreeId }) => {
        window.__store?.getState().setActiveWorktree(worktreeId, `runtime:${environmentId}`)
      },
      { environmentId: client.environmentId, worktreeId }
    )
    await expect
      .poll(() => readClientTabs(page, worktreeId), {
        timeout: 60_000,
        message: 'paired client did not materialize the host terminal'
      })
      .toMatchObject({ terminalTabIds: expect.arrayContaining([expect.any(String)]) })

    await openFileExplorer(page)
    const fixtureRow = page.locator('[data-file-explorer-row]').filter({ hasText: FIXTURE_NAME })
    await expect(fixtureRow).toBeVisible({ timeout: 30_000 })
    await fixtureRow.click()
    const openPreviewToSide = page.getByRole('button', { name: 'Open Preview to the Side' })
    await expect(openPreviewToSide).toBeVisible({ timeout: 30_000 })
    const baselineClient = await readClientTabs(page, worktreeId)
    expect(baselineClient.editorTabIds).not.toHaveLength(0)
    expect(baselineClient.terminalTabIds).not.toHaveLength(0)
    const baselineHostBrowserIds = await readHostBrowserPageIds(args.hostClient, args.repoPath)

    await page.evaluate(() => {
      const fault = (window as FaultWindow).__webRuntimeBrowserCreationFault
      if (!fault) {
        throw new Error('Browser reconciliation E2E fault seam unavailable')
      }
      fault.arm()
    })
    await openPreviewToSide.click()

    const faultSnapshot = await expect
      .poll(
        () =>
          page.evaluate(
            () => (window as FaultWindow).__webRuntimeBrowserCreationFault?.snapshot() ?? null
          ),
        { timeout: 30_000, message: 'host browser creation never reached the held fault seam' }
      )
      .toMatchObject({ armed: true, createdPageId: expect.any(String) })
      .then(() =>
        page.evaluate(
          () => (window as FaultWindow).__webRuntimeBrowserCreationFault?.snapshot() ?? null
        )
      )
    const createdPageId = faultSnapshot?.createdPageId
    if (!createdPageId) {
      throw new Error('Held browser creation did not expose its exact host page id')
    }

    expect(await readHostBrowserPageIds(args.hostClient, args.repoPath)).toContain(createdPageId)
    // Why: the tab is staged on click, so while the create is held the user already sees it —
    // exactly one of it, in the new split. The rollback assertions after release are what prove
    // the optimism is unwound rather than stranded.
    const heldClient = await readClientTabs(page, worktreeId)
    const addedSince = (baseline: string[], held: string[]): string[] => {
      expect(held).toEqual(expect.arrayContaining(baseline))
      return held.filter((id) => !baseline.includes(id))
    }
    expect(addedSince(baselineClient.browserTabIds, heldClient.browserTabIds)).toHaveLength(1)
    expect(
      addedSince(baselineClient.browserWorkspaceIds, heldClient.browserWorkspaceIds)
    ).toHaveLength(1)
    expect(heldClient.editorTabIds).toEqual(baselineClient.editorTabIds)
    expect(heldClient.terminalTabIds).toEqual(baselineClient.terminalTabIds)
    expect(addedSince(baselineClient.groupIds, heldClient.groupIds)).toHaveLength(1)

    await page.screenshot({
      path: args.testInfo.outputPath(`${args.topology}-browser-reconciliation-held.png`),
      fullPage: true
    })
    expect(
      await page.evaluate(
        () => (window as FaultWindow).__webRuntimeBrowserCreationFault?.release() ?? false
      )
    ).toBe(true)

    await expect(page.getByText('Unable to open this file in Orca Browser.')).toBeVisible({
      timeout: 30_000
    })
    await expect
      .poll(() => readHostBrowserPageIds(args.hostClient, args.repoPath), {
        timeout: 30_000,
        message: 'rollback did not close the exact host browser page'
      })
      .not.toContain(createdPageId)
    const settledClient = await expect
      .poll(() => readClientTabs(page, worktreeId), {
        timeout: 30_000,
        message: 'client split and browser state did not settle after rollback'
      })
      .toMatchObject({
        browserTabIds: baselineClient.browserTabIds,
        browserWorkspaceIds: baselineClient.browserWorkspaceIds,
        editorTabIds: baselineClient.editorTabIds,
        groupIds: baselineClient.groupIds,
        terminalTabIds: baselineClient.terminalTabIds
      })
      .then(() => readClientTabs(page, worktreeId))
    expect(settledClient).toEqual(baselineClient)
    expect(await readHostBrowserPageIds(args.hostClient, args.repoPath)).toEqual(
      baselineHostBrowserIds
    )
    await page.evaluate(() => (window as FaultWindow).__webRuntimeBrowserCreationFault?.reset())
  } finally {
    await client?.dispose()
  }
}

async function runCapabilityFailureJourney(args: {
  hostClient: RuntimeClient
  offer: RuntimeDesktopPairingOffer
  repoPath: string
  testInfo: TestInfo
  topology: 'headed' | 'headless'
}): Promise<void> {
  let client: PairedElectronClient | null = null
  try {
    client = await launchPairedElectronClient(
      args.offer,
      args.testInfo,
      `${args.topology} browser capability failure`
    )
    await client.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.show())
    const page = client.page
    const worktreeId = await expect
      .poll(
        () =>
          page.evaluate((repoPath) => {
            const state = window.__store?.getState()
            return state?.allWorktrees().find((worktree) => worktree.path === repoPath)?.id ?? null
          }, args.repoPath),
        { timeout: 60_000, message: 'paired client never received the host worktree' }
      )
      .not.toBeNull()
      .then(() =>
        page.evaluate((repoPath) => {
          const state = window.__store?.getState()
          return state?.allWorktrees().find((worktree) => worktree.path === repoPath)?.id ?? null
        }, args.repoPath)
      )
    if (!worktreeId) {
      throw new Error('Paired client worktree disappeared after discovery')
    }
    await page.evaluate(
      ({ environmentId, worktreeId }) => {
        window.__store?.getState().setActiveWorktree(worktreeId, `runtime:${environmentId}`)
      },
      { environmentId: client.environmentId, worktreeId }
    )
    await expect
      .poll(() => readClientTabs(page, worktreeId), {
        timeout: 60_000,
        message: 'paired client did not materialize the host terminal'
      })
      .toMatchObject({ terminalTabIds: expect.arrayContaining([expect.any(String)]) })

    await openFileExplorer(page)
    const fixtureRow = page.locator('[data-file-explorer-row]').filter({ hasText: FIXTURE_NAME })
    await expect(fixtureRow).toBeVisible({ timeout: 30_000 })
    await fixtureRow.click()
    const openPreviewToSide = page.getByRole('button', { name: 'Open Preview to the Side' })
    await expect(openPreviewToSide).toBeVisible({ timeout: 30_000 })
    const baselineClient = await readClientTabs(page, worktreeId)
    const baselineHost = await readHostTabs(args.hostClient, args.repoPath)

    await page.evaluate(() => {
      const fault = (window as FaultWindow).__webRuntimeBrowserCreationFault
      if (!fault) {
        throw new Error('Browser capability E2E fault seam unavailable')
      }
      fault.armCapabilityRejection()
    })
    await openPreviewToSide.click()

    await expect(page.getByText('Unable to open this file in Orca Browser.')).toBeVisible({
      timeout: 30_000
    })
    await expect
      .poll(() => readClientTabs(page, worktreeId), {
        timeout: 30_000,
        message: 'client split state did not settle after capability rejection'
      })
      .toEqual(baselineClient)
    expect(await readHostTabs(args.hostClient, args.repoPath)).toEqual(baselineHost)
    await page.screenshot({
      path: args.testInfo.outputPath(`${args.topology}-browser-capability-rejected.png`),
      fullPage: true
    })
    await page.evaluate(() => (window as FaultWindow).__webRuntimeBrowserCreationFault?.reset())
  } finally {
    await client?.dispose()
  }
}

// OBSOLETE (a06256841e, STA-5758 "reland remote HTML document previews"): "Open Preview to the
// Side" on a paired workspace no longer creates a page on the host. file-preview.ts:68-79 returns
// the `doc-preview` plan for any paired-runtime worktree, and openDocPreviewTab (file-preview.ts:190)
// builds a client-local page with `browserRuntimeEnvironmentId: null`, which browser.ts:409-420
// resolves to the LOCAL execution host. No browser.tabCreate is sent, so the fault seam at
// web-runtime-browser-creation.ts:121 is unreachable from this route, and the toast asserted below
// ('Unable to open this file in Orca Browser.') was deleted by the same commit and exists nowhere
// in src/. The paired preview route is covered by paired-remote-html-preview-local-render.spec.ts;
// the reconciliation rollback by paired-instant-browser-tab.spec.ts:366. Delete this file.
test.skip('rolls back a headed-host browser when client reconciliation times out @headful', async ({
  electronApp,
  orcaPage,
  testRepoPath
}, testInfo) => {
  test.setTimeout(300_000)
  writeFileSync(
    path.join(testRepoPath, FIXTURE_NAME),
    '<!doctype html><html><body><h1>browser reconciliation fault</h1></body></html>\n'
  )
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  await runReconciliationFailureJourney({
    // Why 30s: browser.tabList on a headed host with no live browser tab first activates the
    // browser view and waits up to 8s for a webview registration before answering; a 5s client
    // times out before the runtime ever replies.
    hostClient: new RuntimeClient(userDataDir, 30_000),
    offer,
    repoPath: testRepoPath,
    testInfo,
    topology: 'headed'
  })
})

// OBSOLETE — same cause as the test above: the preview route never enters
// createWebRuntimeSessionBrowserTab, so the capability seam at
// web-runtime-browser-creation-context.ts:114 is never crossed either.
test.skip('cleans up a headed-host preview when capability rejects after preflight @headful', async ({
  electronApp,
  orcaPage,
  testRepoPath
}, testInfo) => {
  test.setTimeout(300_000)
  writeFileSync(
    path.join(testRepoPath, FIXTURE_NAME),
    '<!doctype html><html><body><h1>browser capability fault</h1></body></html>\n'
  )
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  await runCapabilityFailureJourney({
    // Why 30s: browser.tabList on a headed host with no live browser tab first activates the
    // browser view and waits up to 8s for a webview registration before answering; a 5s client
    // times out before the runtime ever replies.
    hostClient: new RuntimeClient(userDataDir, 30_000),
    offer,
    repoPath: testRepoPath,
    testInfo,
    topology: 'headed'
  })
})

// OBSOLETE — same cause as the tests above. This is the only one CI actually runs
// (the others are @headful and playwright.config.ts:46 greps them out of electron-headless),
// and it is the failure reported in run 35528557535: `armed: true, createdPageId: null`.
test.skip('keeps browser failure cleanup on a headless host', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(300_000)
  writeFileSync(
    path.join(testRepoPath, FIXTURE_NAME),
    '<!doctype html><html><body><h1>headless capability fault</h1></body></html>\n'
  )
  const host: HeadlessPairedRuntimeHost = await launchHeadlessPairedRuntimeHost()
  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    await host.client.call('terminal.create', {
      worktree: `path:${testRepoPath}`,
      title: 'Browser failure cleanup canary'
    })
    await runReconciliationFailureJourney({
      hostClient: host.client,
      offer: host.offer,
      repoPath: testRepoPath,
      testInfo,
      topology: 'headless'
    })
    await runCapabilityFailureJourney({
      hostClient: host.client,
      offer: host.offer,
      repoPath: testRepoPath,
      testInfo,
      topology: 'headless'
    })
  } finally {
    await host.dispose()
  }
})
