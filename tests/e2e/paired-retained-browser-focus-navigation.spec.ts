import { test, expect } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import {
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import {
  selectPairedWorktreeGroup,
  waitForPairedWorktreeId
} from './helpers/client-hosted-browser-fixture'
import {
  callBrowser,
  prepareRetainedPointerPages,
  readRetainedFrame,
  readSelection
} from './helpers/retained-browser-pointer-client'
import {
  startRetainedBrowserPointerFixture,
  type RetainedPointerNavigationMode
} from './helpers/retained-browser-pointer-fixture'
import {
  installRetainedPointerNativeObserver,
  readRetainedPointerDocument
} from './helpers/retained-browser-pointer-native-observer'

// Default mode keeps the second fresh case runnable after the first fails.
test.describe.configure({ mode: 'default', retries: 0 })

for (const mode of ['navigate', 'fetch'] satisfies RetainedPointerNavigationMode[]) {
  test(`preserves visible guest focus after a cold retained link ${mode}`, async ({
    testRepoPath
  }, testInfo) => {
    test.setTimeout(180_000)
    const fixture = await startRetainedBrowserPointerFixture(0, mode)
    let host: Awaited<ReturnType<typeof launchHeadlessPairedRuntimeHost>> | null = null
    let client: PairedElectronClient | null = null
    let observer: Awaited<ReturnType<typeof installRetainedPointerNativeObserver>> | null = null
    const stages: { label: string; observation: unknown }[] = []
    const focusSamples: { requestedAtMs: number; completedAtMs: number; selection: unknown }[] = []
    let nativeReceipt: unknown = null
    let failure: string | null = null
    const cleanupErrors: string[] = []
    try {
      host = await launchHeadlessPairedRuntimeHost()
      await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
      await host.client.call('terminal.create', {
        worktree: `path:${testRepoPath}`,
        title: 'Retained browser pointer canary'
      })
      client = await launchPairedElectronClient(host.offer, testInfo, 'Retained pointer viewer')
      const worktreeId = await waitForPairedWorktreeId(client.page, testRepoPath)
      await selectPairedWorktreeGroup(client.page, client.environmentId, worktreeId)
      const { target, visible, parked, visibleNativeId } = await prepareRetainedPointerPages(
        client,
        worktreeId,
        fixture.origin
      )
      const targetNativeId = parked?.webContentsId
      if (!targetNativeId || !visibleNativeId) {
        throw new Error('retained pointer native identities unavailable')
      }
      observer = await installRetainedPointerNativeObserver(client, [
        targetNativeId,
        visibleNativeId
      ])
      const observe = async (label: string) => {
        const requestedAtMs = Date.now()
        const selection = await readSelection(client!.page, worktreeId, visible.workspaceId)
        const observation = {
          requestedAtMs,
          selection,
          target: await readRetainedFrame(client!.page, target.remotePageId),
          visible: await readRetainedFrame(client!.page, visible.remotePageId),
          document: await readRetainedPointerDocument(client!, targetNativeId),
          native: await observer!.read(),
          // Playwright emulates document focus; this is not native foreground evidence.
          documentHasFocus: await client!.page.evaluate(() => document.hasFocus()),
          completedAtMs: Date.now()
        }
        stages.push({ label, observation })
        return observation
      }
      const waitForParking = async () => {
        await expect
          .poll(() => readRetainedFrame(client!.page, target.remotePageId))
          .toMatchObject({ width: 1, height: 1, webContentsId: targetNativeId })
      }
      const before = await observe('before-snapshot')
      expect(before.document.document.documentId).toBeTruthy()
      expect(before.selection).toMatchObject({
        focusedPageId: visible.remotePageId,
        focusedWebContentsId: visibleNativeId
      })
      const snapshot = (await callBrowser(
        client,
        worktreeId,
        target.remotePageId,
        'browser.snapshot'
      )) as { snapshot: string }
      expect(snapshot.snapshot).toContain('Activate test link')
      await waitForParking()
      const afterSnapshot = await observe('after-snapshot-release')
      expect(afterSnapshot.selection).toEqual(before.selection)
      await callBrowser(client, worktreeId, target.remotePageId, 'browser.click', {
        element: '#activate'
      })
      await observe('after-click-rpc')
      await expect.poll(fixture.activations).toBe(1)
      await expect.poll(() => fixture.clicks.length).toBe(1)
      expect(fixture.clicks[0]).toMatchObject({
        trusted: true,
        targetId: 'activate',
        targetTag: 'A',
        documentId: before.document.document.documentId
      })
      expect(fixture.clicks[0].innerWidth).toBeGreaterThan(1)
      expect(fixture.clicks[0].innerHeight).toBeGreaterThan(1)
      if (mode === 'navigate') {
        await expect
          .poll(async () => (await observer!.read()).counts[`${targetNativeId}:did-navigate`])
          .toBe(1)
        await expect
          .poll(async () => (await observer!.read()).counts[`${targetNativeId}:did-finish-load`])
          .toBe(1)
      }
      await waitForParking()
      const after = await observe('after-effect-and-parking')
      if (mode === 'navigate') {
        expect(after.document.document.url).toBe(`${fixture.origin}/activation`)
        expect(after.document.document.documentId).not.toBe(before.document.document.documentId)
      } else {
        expect(after.document.document).toEqual(before.document.document)
      }
      expect(after.visible).toEqual(before.visible)
      const observeUntil = Date.now() + 10_000
      while (Date.now() < observeUntil) {
        const requestedAtMs = Date.now()
        const selection = await readSelection(client.page, worktreeId, visible.workspaceId)
        focusSamples.push({ requestedAtMs, completedAtMs: Date.now(), selection })
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      const settled = await observe('after-focus-observation-period')
      expect(settled.selection).toEqual(before.selection)
    } catch (error) {
      failure = String(error)
      throw error
    } finally {
      try {
        if (observer) {
          nativeReceipt = await observer.dispose()
        }
      } catch (error) {
        cleanupErrors.push(`native observer: ${String(error)}`)
      }
      const results = await Promise.allSettled([
        client?.dispose(),
        host?.dispose(),
        fixture.close()
      ])
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          cleanupErrors.push(`fixture ${index}: ${result.reason}`)
        }
      })
      await testInfo.attach(`retained-focus-${mode}-receipt`, {
        body: JSON.stringify(
          {
            mode,
            stages,
            focusSamples,
            clicks: fixture.clicks,
            activations: fixture.activations(),
            nativeReceipt,
            failure,
            cleanupErrors
          },
          null,
          2
        ),
        contentType: 'application/json'
      })
      if (!failure) {
        expect(cleanupErrors, 'fixture cleanup').toEqual([])
      }
    }
  })
}
