import type { Page } from '@stablyai/playwright-test'
import { expect } from './orca-app'
import type { PairedElectronClient } from './paired-electron-client'
import {
  openClientHostedFixturePage,
  waitForRenderedClientWebview
} from './client-hosted-browser-fixture'

export async function readRetainedFrame(page: Page, remotePageId: string) {
  return page.evaluate((pageId) => {
    const host = document.querySelector<HTMLElement>(
      `[data-browser-client-page-id="${CSS.escape(pageId)}"]`
    )
    const guest = host?.querySelector('webview') as Electron.WebviewTag | null
    if (!host || !guest) {
      return null
    }
    const rect = host.getBoundingClientRect()
    return {
      webContentsId: guest.getWebContentsId(),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      connected: host.isConnected && guest.isConnected,
      inert: host.inert,
      opacity: getComputedStyle(host).opacity,
      pointerEvents: getComputedStyle(host).pointerEvents
    }
  }, remotePageId)
}

export async function callBrowser(
  client: PairedElectronClient,
  worktreeId: string,
  remotePageId: string,
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  return client.page.evaluate(
    async (args) => {
      const response = await window.api.runtimeEnvironments.call({
        selector: args.environmentId,
        method: args.method,
        params: { ...args.params, page: args.remotePageId, worktree: `id:${args.worktreeId}` },
        timeoutMs: 30_000
      })
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
      return response.result
    },
    { environmentId: client.environmentId, method, params, remotePageId, worktreeId }
  )
}

export async function readSelection(page: Page, worktreeId: string, workspaceId: string) {
  return page.evaluate(
    ({ worktreeId, workspaceId }) => {
      const state = window.__store?.getState()
      const active = document.activeElement
      let focusedWebContentsId: number | null = null
      if (active?.tagName === 'WEBVIEW') {
        try {
          focusedWebContentsId = (active as Electron.WebviewTag).getWebContentsId()
        } catch {}
      }
      return {
        worktree: state?.activeWorktreeId,
        group: state?.activeGroupIdByWorktree[worktreeId],
        page: state?.browserTabsByWorktree[worktreeId]?.find((tab) => tab.id === workspaceId)
          ?.activePageId,
        focusedTag: active?.tagName,
        focusedId: active?.id,
        focusedPageId:
          active
            ?.closest('[data-browser-client-page-id]')
            ?.getAttribute('data-browser-client-page-id') ?? null,
        focusedWebContentsId,
        focusedShadowTag: active?.shadowRoot?.activeElement?.tagName ?? null
      }
    },
    { worktreeId, workspaceId }
  )
}

export async function prepareRetainedPointerPages(
  client: PairedElectronClient,
  worktreeId: string,
  origin: string
) {
  const target = await openClientHostedFixturePage(client, worktreeId, `${origin}/target`)
  await waitForRenderedClientWebview(
    client.page,
    {
      urlPrefix: origin,
      remotePageId: target.remotePageId
    },
    'target guest never rendered'
  )
  const visible = await openClientHostedFixturePage(client, worktreeId, `${origin}/visible`)
  await waitForRenderedClientWebview(
    client.page,
    {
      urlPrefix: origin,
      remotePageId: visible.remotePageId
    },
    'user-visible guest never rendered'
  )
  await expect
    .poll(async () => (await readRetainedFrame(client.page, target.remotePageId))?.width)
    .toBe(1)
  const parked = await readRetainedFrame(client.page, target.remotePageId)
  expect(parked?.height).toBe(1)
  await expect
    .poll(async () => (await readRetainedFrame(client.page, visible.remotePageId))?.width)
    .toBeGreaterThan(1)
  const visibleNativeId = (await readRetainedFrame(client.page, visible.remotePageId))
    ?.webContentsId
  expect(visibleNativeId).toBeGreaterThan(0)
  await client.page.evaluate(async (pageId) => {
    const guest = document.querySelector(
      `[data-browser-client-page-id="${CSS.escape(pageId)}"] webview`
    ) as Electron.WebviewTag
    guest.focus()
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    )
  }, visible.remotePageId)
  await expect
    .poll(() => readSelection(client.page, worktreeId, visible.workspaceId))
    .toMatchObject({
      focusedPageId: visible.remotePageId,
      focusedWebContentsId: visibleNativeId
    })

  return { target, visible, parked, visibleNativeId }
}
