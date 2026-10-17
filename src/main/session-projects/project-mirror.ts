import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow, IpcMainEvent } from 'electron'
import { SESSION_PROJECT_MIRROR_CHANNEL } from '../../shared/session-folder-cli-channels'
import {
  SESSION_FOLDERS_NO_WINDOW_ERROR,
  type SessionFolderRelayRequest
} from '../../shared/session-folder-cli'
import {
  parseSessionProjectMirror,
  readProjectFromFolders,
  type SessionProjectMirror
} from '../../shared/session-project-mirror'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { getRuntimeDesktopSurface } from '../runtime/runtime-desktop-surface'

/**
 * Main's copy of the projects for when no window is open (upgrade plan decision 1): the window
 * pushes it on each change and it is kept on disk, so a routine run or a `--project` worker on a
 * window-less desktop still gets its project's brief. Filing still needs the window.
 */

const MIRROR_FILE = 'session-projects-mirror.json'

let mirror: SessionProjectMirror | null | undefined
let userDataPath: (() => string) | null = null

// Why lazy: the profile's data folder is settled after this is installed.
const mirrorPath = () => (userDataPath ? join(userDataPath(), MIRROR_FILE) : null)

function load(): SessionProjectMirror | null {
  if (mirror !== undefined) {
    return mirror
  }
  mirror = null
  const path = mirrorPath()
  if (path && existsSync(path)) {
    try {
      mirror = parseSessionProjectMirror(JSON.parse(readFileSync(path, 'utf-8')))
    } catch {
      mirror = null
    }
  }
  return mirror
}

export function setSessionProjectMirror(value: unknown): boolean {
  const parsed = parseSessionProjectMirror(value)
  if (!parsed) {
    return false
  }
  mirror = parsed
  const path = mirrorPath()
  if (path) {
    try {
      writeFileAtomically(path, JSON.stringify(parsed))
    } catch (error) {
      console.warn('[projects] could not keep the project mirror:', error)
    }
  }
  return true
}

/** Takes the mirror only from the window that owns the folders. */
export function installSessionProjectMirror(args: {
  userDataPath: () => string
  getWindow: () => BrowserWindow | null
}): void {
  userDataPath = args.userDataPath
  mirror = undefined
  getRuntimeDesktopSurface().onIpc(
    SESSION_PROJECT_MIRROR_CHANNEL,
    (event: IpcMainEvent, value: unknown) => {
      const win = args.getWindow()
      if (win && !win.isDestroyed() && event.sender === win.webContents) {
        setSessionProjectMirror(value)
      }
    }
  )
}

/** Answers a project read from the mirror, only when the window could not be asked at all. */
export async function withSessionProjectMirror(
  request: SessionFolderRelayRequest,
  ask: () => Promise<unknown>
): Promise<unknown> {
  try {
    return await ask()
  } catch (error) {
    const noWindow = error instanceof Error && error.message === SESSION_FOLDERS_NO_WINDOW_ERROR
    const saved = noWindow && request.kind === 'readProject' ? load() : null
    if (!saved || request.kind !== 'readProject') {
      throw error
    }
    return readProjectFromFolders(saved.folders, saved.projects, request.folder)
  }
}
