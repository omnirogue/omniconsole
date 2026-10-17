import { ipcMain, nativeImage } from 'electron'
import { connect } from 'node:net'
import { extname, isAbsolute } from 'node:path'
import { stat } from 'node:fs/promises'
import type { Store } from '../persistence'
import {
  connectableLoopbackHost,
  normalizeLocalhostHostname,
  parseLoopbackUrlWithPort
} from '../../shared/localhost-worktree-labels'
import { SESSION_VIDEO_EXTENSIONS } from '../../shared/session-file-kind'
import { resolveAuthorizedReadPath } from './local-worktree-read-authorization'
import { readSessionPullRequestFacts } from '../github/session-pull-request-facts'
import { getSessionSearchService } from '../session-search/session-search-service'
import { parseGitHubPullRequestUrl } from '../../shared/session-links'
import { SESSION_PULL_REQUEST_LIMIT } from '../../shared/session-pull-request-refs'

export type LoopbackProbeResult = 'live' | 'stopped' | 'unverifiable'

const PROBE_TIMEOUT_MS = 1_500
const THUMBNAIL_SIZE = { width: 192, height: 192 }
/** QuickLook reads only what it needs, but a multi-gigabyte capture is not worth the wait. */
const MAX_VIDEO_THUMBNAIL_BYTES = 2 * 1024 * 1024 * 1024

/**
 * Whether something is listening on a loopback URL's port. A TCP connect is the whole probe: no
 * request bytes are sent, so a dev server sees nothing, and non-loopback hosts are refused before
 * any socket opens (this must never become a way to reach other machines).
 */
export function probeLoopbackUrl(rawUrl: unknown): Promise<LoopbackProbeResult> {
  const parsed = typeof rawUrl === 'string' ? parseLoopbackUrlWithPort(rawUrl) : null
  if (!parsed) {
    return Promise.reject(new Error('Only loopback URLs with a port can be probed.'))
  }
  const port = Number(parsed.port)
  const host = connectableLoopbackHost(normalizeLocalhostHostname(parsed.hostname))
  return new Promise((resolve) => {
    const socket = connect({ port, host })
    const finish = (result: LoopbackProbeResult): void => {
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(PROBE_TIMEOUT_MS, () => finish('unverifiable'))
    socket.once('connect', () => finish('live'))
    socket.once('error', (error: NodeJS.ErrnoException) =>
      finish(error.code === 'ECONNREFUSED' ? 'stopped' : 'unverifiable')
    )
  })
}

/**
 * A small first-frame thumbnail for a local video the session wrote, as a data URL. The path goes
 * through the same read authorization as fs:readFile, so only files inside the registered
 * workspaces (or ones the person already opened) qualify; the OS thumbnailer never plays audio or
 * runs anything. Returns null where the platform has no thumbnailer (Linux).
 */
export async function videoThumbnail(store: Store, args: unknown): Promise<string | null> {
  const filePath =
    args && typeof args === 'object' ? (args as { filePath?: unknown }).filePath : undefined
  if (typeof filePath !== 'string' || !isAbsolute(filePath)) {
    throw new Error('A video thumbnail needs an absolute file path.')
  }
  if (!SESSION_VIDEO_EXTENSIONS.has(extname(filePath).slice(1).toLowerCase())) {
    throw new Error('Only video files have thumbnails here.')
  }
  const authorized = await resolveAuthorizedReadPath(filePath, store)
  const stats = await stat(authorized)
  if (!stats.isFile() || stats.size > MAX_VIDEO_THUMBNAIL_BYTES) {
    return null
  }
  try {
    const image = await nativeImage.createThumbnailFromPath(authorized, THUMBNAIL_SIZE)
    return image.isEmpty() ? null : image.toDataURL()
  } catch {
    return null
  }
}

export function registerSessionFilePreviewHandlers(store: Store): void {
  ipcMain.handle('sessionFiles:indexedPullRequests', async (_event, args: unknown) => {
    const value = args as { agent?: unknown; sessionId?: unknown } | null
    if (
      !value ||
      typeof value.agent !== 'string' ||
      !['claude', 'codex'].includes(value.agent) ||
      typeof value.sessionId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(value.sessionId)
    ) {
      return null
    }
    const links = await getSessionSearchService()
      ?.sessionLinks(`${value.agent}:${value.sessionId}`)
      .catch(() => null)
    return links
      ? links
          .flatMap((url) => {
            const ref = parseGitHubPullRequestUrl(url)
            return ref ? [ref] : []
          })
          .slice(-SESSION_PULL_REQUEST_LIMIT)
      : null
  })
  ipcMain.handle('sessionFiles:probeLoopback', (_event, url: unknown) => probeLoopbackUrl(url))
  ipcMain.handle('sessionFiles:videoThumbnail', (_event, args: unknown) =>
    videoThumbnail(store, args)
  )
  ipcMain.handle('sessionFiles:pullRequestFacts', (_event, ref: unknown) =>
    readSessionPullRequestFacts(ref)
  )
}
