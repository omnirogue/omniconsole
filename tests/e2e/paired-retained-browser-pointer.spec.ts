import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
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
import { startRetainedBrowserPointerFixture } from './helpers/retained-browser-pointer-fixture'
import {
  callBrowser,
  prepareRetainedPointerPages,
  readRetainedFrame,
  readSelection
} from './helpers/retained-browser-pointer-client'

test('activates parked retained links and receives exact bytes through paired automation', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(300_000)
  const fixture = await startRetainedBrowserPointerFixture()
  let host: Awaited<ReturnType<typeof launchHeadlessPairedRuntimeHost>> | null = null
  let client: PairedElectronClient | null = null
  const stages: { label: string; observation: unknown }[] = []
  let downloadReceipt: { destination: string; sha256: string } | null = null
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

    const observe = async (label: string) => {
      const selection = await readSelection(client!.page, worktreeId, visible.workspaceId)
      const native = await client!.app.evaluate(({ BrowserWindow, webContents }) => ({
        focusedWebContentsId: webContents.getFocusedWebContents()?.id ?? null,
        windows: BrowserWindow.getAllWindows().map((window) => ({
          id: window.id,
          visible: window.isVisible(),
          focused: window.isFocused()
        }))
      }))
      stages.push({
        label,
        observation: {
          selection,
          target: await readRetainedFrame(client!.page, target.remotePageId),
          visible: await readRetainedFrame(client!.page, visible.remotePageId),
          native,
          // Playwright enables focus emulation; this is not native-window focus evidence.
          documentHasFocus: await client!.page.evaluate(() => document.hasFocus())
        }
      })
    }
    const waitForParking = async () => {
      await expect
        .poll(() => readRetainedFrame(client!.page, target.remotePageId))
        .toMatchObject({ width: 1, height: 1, webContentsId: parked?.webContentsId })
    }

    const command = (method: string, params?: Record<string, unknown>) =>
      callBrowser(client!, worktreeId, target.remotePageId, method, params)
    let expectedActivations = 0
    const activate = async (
      label: string,
      useReference: boolean,
      emulation?: { width: number; height: number; mobile?: boolean }
    ) => {
      await observe(`${label}:before`)
      const selection = await readSelection(client!.page, worktreeId, visible.workspaceId)
      expect(selection).toMatchObject({
        focusedPageId: visible.remotePageId,
        focusedWebContentsId: visibleNativeId
      })
      const visibleFrame = await readRetainedFrame(client!.page, visible.remotePageId)
      const snapshot = (await command('browser.snapshot')) as { snapshot: string }
      await waitForParking()
      await observe(`${label}:after-snapshot-release`)
      expect(await readSelection(client!.page, worktreeId, visible.workspaceId)).toEqual(selection)
      expect(snapshot.snapshot).toContain('Activate test link')
      const ref = snapshot.snapshot
        .split('\n')
        .find((line) => line.includes('Activate test link'))
        ?.match(/\[ref=(e\d+)\]/)?.[1]
      if (useReference) {
        expect(ref, 'fresh snapshot must identify the intended link').toBeTruthy()
      }
      await command('browser.click', { element: useReference ? `@${ref}` : '#activate' })
      await observe(`${label}:after-click-rpc`)
      expectedActivations += 1
      await expect.poll(fixture.activations).toBe(expectedActivations)
      await expect.poll(() => fixture.clicks.length).toBe(expectedActivations)
      const click = fixture.clicks.at(-1)!
      expect(click).toMatchObject({ trusted: true, targetId: 'activate', targetTag: 'A' })
      expect(click.innerWidth).toBeGreaterThan(1)
      expect(click.innerHeight).toBeGreaterThan(1)
      if (emulation?.mobile) {
        expect(click).toMatchObject({
          screenWidth: emulation.width,
          screenHeight: emulation.height
        })
      } else if (emulation) {
        expect(click).toMatchObject({ innerWidth: emulation.width, innerHeight: emulation.height })
      }
      // Main releases the renderer lease asynchronously after returning the RPC result.
      await waitForParking()
      await observe(`${label}:after-click-release`)
      await expect
        .poll(() => readSelection(client!.page, worktreeId, visible.workspaceId))
        .toEqual(selection)
      expect(await readRetainedFrame(client!.page, visible.remotePageId)).toEqual(visibleFrame)
      expect((await readRetainedFrame(client!.page, target.remotePageId))?.webContentsId).toBe(
        parked?.webContentsId
      )
    }

    await activate('implicit-css-cold', false)
    await activate('implicit-reference', true)
    await command('browser.viewport', { width: 1024, height: 768 })
    await activate('desktop-reference', true, { width: 1024, height: 768 })
    await command('browser.viewport', {
      width: 375,
      height: 812,
      deviceScaleFactor: 2,
      mobile: true
    })
    await activate('mobile-css', false, { width: 375, height: 812, mobile: true })
    expect(
      await client.page.evaluate(
        (browserPageId) =>
          window.api.browser.setViewportOverride({ browserPageId, override: null }),
        target.remotePageId
      )
    ).toBe(true)
    await client.page.evaluate((pageId) => {
      const guest = document.querySelector(
        `[data-browser-client-page-id="${CSS.escape(pageId)}"] webview`
      ) as Electron.WebviewTag
      guest.setZoomFactor(1.1)
    }, target.remotePageId)
    const clientWindow = await client.app.browserWindow(client.page)
    await clientWindow.evaluate((window) => {
      window.webContents.setZoomFactor(1.25)
      window.setSize(1100, 850)
    })
    await activate('cleared-viewport-zoomed-reference', true)

    const downloadSelection = await readSelection(client.page, worktreeId, visible.workspaceId)
    await command('browser.click', { element: '#download' })
    await observe('download:after-click-rpc')
    const destination = path.join(testRepoPath, '.omni', 'browser-downloads', fixture.filename)
    await expect
      .poll(async () => readFile(destination).catch(() => null), { timeout: 30_000 })
      .toEqual(fixture.bytes)
    const received = await readFile(destination)
    expect(createHash('sha256').update(received).digest('hex')).toBe(
      createHash('sha256').update(fixture.bytes).digest('hex')
    )
    expect(await readdir(path.dirname(destination))).toEqual([fixture.filename])
    await expect.poll(() => fixture.clicks.length).toBe(expectedActivations + 1)
    expect(fixture.clicks.at(-1)).toMatchObject({
      trusted: true,
      targetId: 'download',
      targetTag: 'A'
    })
    await waitForParking()
    await observe('download:after-release')
    await expect
      .poll(() => readSelection(client!.page, worktreeId, visible.workspaceId))
      .toEqual(downloadSelection)
    downloadReceipt = {
      destination,
      sha256: createHash('sha256').update(received).digest('hex')
    }
  } finally {
    try {
      await testInfo.attach('retained-pointer-receipt', {
        body: JSON.stringify(
          { stages, clicks: fixture.clicks, activations: fixture.activations(), downloadReceipt },
          null,
          2
        ),
        contentType: 'application/json'
      })
    } finally {
      const results = await Promise.allSettled([
        client?.dispose(),
        host?.dispose(),
        fixture.close()
      ])
      expect(
        results.filter((result) => result.status === 'rejected'),
        'fixture cleanup'
      ).toEqual([])
    }
  }
})
