import { useAppStore } from '@/store'
import { isUnifiedTabPinned } from '@/store/pinned-tab-close-guard'
import {
  BROWSER_CLEANUP_INSPECTION,
  type BrowserCleanupMode,
  type BrowserCleanupReport,
  type BrowserCleanupRequest,
  type BrowserCleanupRow
} from '../../../../shared/browser-cleanup'
import { webviewRegistry } from './host-guest/webview-registry'
import { browserPageNeedsPaintRetention } from './host-guest/browser-guest-paint-retention'
import { hasActiveBrowserPageDownload } from './navigate/browser-page-download-activity'

type Candidate = {
  row: BrowserCleanupRow
  guest: Electron.WebviewTag | undefined
  guestId: number | null
  navigated?: boolean
  release?: () => void
}
type Preview = { report: BrowserCleanupReport; candidates: Candidate[] }
const previews = new Map<string, Preview>()
let applying = false

function inventory(): Candidate[] {
  const state = useAppStore.getState()
  return Object.entries(state.browserTabsByWorktree).flatMap(([worktreeId, workspaces]) =>
    workspaces.flatMap((workspace) => {
      const pages = state.browserPagesByWorkspace[workspace.id] ?? []
      return (pages.length ? pages : [workspace]).map((page) => {
        const guest = webviewRegistry.get(page.id)
        let guestId: number | null = null
        try {
          guestId = guest?.getWebContentsId() ?? null
        } catch {
          /* Guest is unavailable. */
        }
        return {
          guest,
          guestId,
          row: {
            pageId: page.id,
            workspaceId: workspace.id,
            worktreeId,
            profileId: workspace.sessionProfileId ?? null,
            title: page.title || 'Untitled page',
            url: page.url,
            eligible: false,
            reason: 'Not checked'
          }
        }
      })
    })
  )
}

function holdReason(candidate: Candidate, mode: BrowserCleanupMode): string | null {
  const state = useAppStore.getState()
  const { row, guest, guestId } = candidate
  if (candidate.navigated) {
    return 'Page navigated since preview'
  }
  const workspace = state.browserTabsByWorktree[row.worktreeId]?.find(
    (w) => w.id === row.workspaceId
  )
  const page = state.browserPagesByWorkspace[row.workspaceId]?.find((p) => p.id === row.pageId)
  if (!workspace || (!page && workspace.id !== row.pageId)) {
    return 'Page changed or closed'
  }
  if (state.settings?.activeRuntimeEnvironmentId) {
    return 'This window is viewing another computer'
  }
  if (page?.browserRuntimeEnvironmentId || state.remoteBrowserPageHandlesByPageId[row.pageId]) {
    return 'Page belongs to another browser host'
  }
  if ((page ?? workspace).docLocation) {
    return 'Workspace document; keep its document context'
  }
  if (isUnifiedTabPinned(state, row.worktreeId, row.workspaceId)) {
    return 'Pinned page'
  }
  if (state.browserAnnotationsByPageId[row.pageId]?.length) {
    return 'Page has annotations'
  }
  if (hasActiveBrowserPageDownload(row.pageId)) {
    return 'Download in progress'
  }
  if (browserPageNeedsPaintRetention(row.pageId)) {
    return 'Page is being used by an agent or another device'
  }
  if (
    mode === 'unused' &&
    (workspace.activePageId ?? workspace.id) === row.pageId &&
    state.activeWorktreeId === row.worktreeId &&
    state.activeBrowserTabIdByWorktree[row.worktreeId] === row.workspaceId
  ) {
    return 'Current page'
  }
  if (!guest || webviewRegistry.get(row.pageId) !== guest || guest.getWebContentsId() !== guestId) {
    return 'Page is not available for inspection'
  }
  if ((page ?? workspace).url !== row.url || guest.getURL() !== row.url) {
    return 'Page navigated'
  }
  if (guest.isLoading() || guest.isCurrentlyAudible()) {
    return 'Page is loading or playing audio'
  }
  if (!/^(https?:|file:|about:blank$)/.test(row.url)) {
    return 'Page address cannot be reopened safely'
  }
  return null
}

async function inspect(candidate: Candidate, mode: BrowserCleanupMode): Promise<string | null> {
  try {
    const held = holdReason(candidate, mode)
    if (held) {
      return held
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result: unknown = await Promise.race([
        candidate.guest!.executeJavaScript(BROWSER_CLEANUP_INSPECTION),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Inspection timed out')), 1500)
        })
      ])
      if (result !== null) {
        return typeof result === 'string' ? result : 'Page could not be checked'
      }
      return holdReason(candidate, mode)
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return 'Page could not be checked'
  }
}

export async function runBrowserCleanup(
  request: BrowserCleanupRequest
): Promise<BrowserCleanupReport> {
  if (applying) {
    throw new Error('Browser cleanup is already running')
  }
  if (request.action === 'preview') {
    const candidates = inventory()
    for (const candidate of candidates) {
      const changed = (): void => {
        candidate.navigated = true
      }
      candidate.guest?.addEventListener('did-start-navigation', changed)
      candidate.guest?.addEventListener('dom-ready', changed)
      candidate.release = () => {
        candidate.guest?.removeEventListener('did-start-navigation', changed)
        candidate.guest?.removeEventListener('dom-ready', changed)
      }
    }
    const rows: BrowserCleanupRow[] = []
    const deadline = Date.now() + 45_000
    for (const candidate of candidates) {
      const reason =
        Date.now() >= deadline
          ? 'Inspection time limit reached'
          : await inspect(candidate, request.mode)
      candidate.row = {
        ...candidate.row,
        eligible: reason === null,
        reason: reason ?? 'Ready to close'
      }
      rows.push(candidate.row)
    }
    const report = {
      token: crypto.randomUUID(),
      mode: request.mode,
      expiresAt: Date.now() + 120_000,
      rows
    }
    for (const [token, preview] of previews) {
      if (preview.report.expiresAt < Date.now()) {
        previews.get(token)?.candidates.forEach((candidate) => candidate.release?.())
        previews.delete(token)
      }
    }
    if (previews.size >= 8) {
      const oldest = previews.keys().next().value!
      previews.get(oldest)?.candidates.forEach((candidate) => candidate.release?.())
      previews.delete(oldest)
    }
    previews.set(report.token, { report, candidates })
    setTimeout(() => {
      const expired = previews.get(report.token)
      expired?.candidates.forEach((candidate) => candidate.release?.())
      previews.delete(report.token)
    }, 120_000)
    return report
  }
  const preview = previews.get(request.token)
  if (!preview || preview.report.expiresAt < Date.now()) {
    throw new Error('Preview expired. Review the pages again.')
  }
  previews.delete(request.token)
  applying = true
  try {
    const rows: BrowserCleanupRow[] = []
    const deadline = Date.now() + 45_000
    for (const candidate of preview.candidates) {
      const reason =
        Date.now() >= deadline
          ? 'Cleanup time limit reached'
          : candidate.row.eligible
            ? await inspect(candidate, preview.report.mode)
            : candidate.row.reason
      if (reason) {
        rows.push({ ...candidate.row, outcome: 'kept', reason })
        continue
      }
      // Main rechecks the guest and keeps pages with registered unload handlers.
      const changed = holdReason(candidate, preview.report.mode)
      if (changed) {
        rows.push({ ...candidate.row, outcome: 'kept', reason: changed })
        continue
      }
      const result = await window.api.browser.cleanupCloseGuest({
        pageId: candidate.row.pageId,
        guestId: candidate.guestId!,
        url: candidate.row.url
      })
      if (result !== 'closed') {
        rows.push({
          ...candidate.row,
          outcome: result,
          reason:
            result === 'kept'
              ? 'Page prevented closing or became active'
              : 'Close is unconfirmed; check the page before retrying'
        })
        continue
      }
      const state = useAppStore.getState()
      const current = state.browserPagesByWorkspace[candidate.row.workspaceId]?.find(
        (page) => page.id === candidate.row.pageId
      )
      if (current && current.url !== candidate.row.url) {
        rows.push({ ...candidate.row, outcome: 'unconfirmed', reason: 'Page changed during close' })
        continue
      }
      const pages = state.browserPagesByWorkspace[candidate.row.workspaceId] ?? []
      if (pages.length <= 1) {
        state.closeBrowserTab(candidate.row.workspaceId)
      } else {
        state.closeBrowserPage(candidate.row.pageId)
      }
      const remains = inventory().some((c) => c.row.pageId === candidate.row.pageId)
      rows.push({
        ...candidate.row,
        outcome: remains ? 'unconfirmed' : 'closed',
        reason: remains ? 'Close was not confirmed' : 'Closed'
      })
    }
    return { ...preview.report, rows }
  } finally {
    preview.candidates.forEach((candidate) => candidate.release?.())
    applying = false
  }
}
