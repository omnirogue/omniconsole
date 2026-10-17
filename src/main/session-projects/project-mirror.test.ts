import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyProjectSettings } from '../../shared/project-settings'
import {
  SESSION_FOLDERS_NO_WINDOW_ERROR,
  SESSION_FOLDERS_TIMEOUT_ERROR
} from '../../shared/session-folder-cli'

const listeners = vi.hoisted(() => new Map<string, (...args: unknown[]) => void>())
vi.mock('../runtime/runtime-desktop-surface', () => ({
  getRuntimeDesktopSurface: () => ({
    onIpc: (channel: string, listener: (...args: unknown[]) => void) =>
      listeners.set(channel, listener)
  })
}))

const { installSessionProjectMirror, withSessionProjectMirror } = await import('./project-mirror')

const settings = emptyProjectSettings(1)
const mirror = {
  folders: [{ id: 'ads', name: 'Ads', path: 'Ads', section: 'active', parentId: null }],
  projects: { ads: settings },
  savedAt: 1
}
const noWindow = () => Promise.reject(new Error(SESSION_FOLDERS_NO_WINDOW_ERROR))

describe('session project mirror', () => {
  let dir: string
  const webContents = {}
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'project-mirror-'))
    installSessionProjectMirror({
      userDataPath: () => dir,
      getWindow: () => ({ isDestroyed: () => false, webContents }) as never
    })
  })

  const push = (sender: unknown, value: unknown) =>
    listeners.get('sessionProjects:mirror')!({ sender }, value)

  it('answers a project read from the copy the window pushed, only when no window answers', async () => {
    push(webContents, mirror)
    const read = { kind: 'readProject' as const, folder: 'Ads' }
    await expect(withSessionProjectMirror(read, noWindow)).resolves.toMatchObject({
      project: { folderId: 'ads', settings }
    })
    await expect(withSessionProjectMirror(read, async () => 'window')).resolves.toBe('window')
    await expect(
      withSessionProjectMirror(read, () => Promise.reject(new Error(SESSION_FOLDERS_TIMEOUT_ERROR)))
    ).rejects.toThrow(SESSION_FOLDERS_TIMEOUT_ERROR)
    await expect(
      withSessionProjectMirror({ kind: 'projectForPane', paneKey: 'p' }, noWindow)
    ).rejects.toThrow(SESSION_FOLDERS_NO_WINDOW_ERROR)
  })

  it('keeps the copy on disk for the next start, and ignores other senders', async () => {
    push({}, { ...mirror, projects: {} })
    await expect(
      withSessionProjectMirror({ kind: 'readProject', folder: 'Ads' }, noWindow)
    ).rejects.toThrow(SESSION_FOLDERS_NO_WINDOW_ERROR)
    push(webContents, mirror)
    const saved = JSON.parse(readFileSync(join(dir, 'session-projects-mirror.json'), 'utf-8'))
    expect(saved.projects.ads).toEqual(settings)
    installSessionProjectMirror({ userDataPath: () => dir, getWindow: () => null })
    await expect(
      withSessionProjectMirror({ kind: 'readProject', folder: 'ads' }, noWindow)
    ).resolves.toMatchObject({ project: { folderId: 'ads' } })
  })
})
