import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResolveContextDocumentRequest } from '../../../shared/session-context-documents'
import type { LaunchProject } from './project-launch'
import {
  clearProjectLaunchDocumentReads,
  refreshProjectLaunchDocuments,
  withFreshProjectDocuments
} from './project-launch-documents'

const resolve = vi.hoisted(() => vi.fn())
vi.mock('./session-context-document-client', () => ({ resolveContextDocument: resolve }))

const project = {
  folderId: 'folder-1',
  name: 'Projects',
  settings: {
    repos: [],
    attachments: [
      { id: 'slite:notes', kind: 'slite', title: 'Notes', content: 'Saved notes' },
      { id: 'instructions:rules', kind: 'instructions', title: 'Rules', content: 'Be brief' }
    ]
  }
} as unknown as LaunchProject

const today = (request: ResolveContextDocumentRequest) => ({
  status: 'ok' as const,
  document: {
    source: request.source,
    id: request.id,
    title: 'Notes',
    url: 'https://slite/notes',
    content: "Today's notes",
    contentType: 'text/markdown' as const,
    capturedAt: 50,
    truncated: false
  }
})

const contentOf = (target: LaunchProject) =>
  target.settings.attachments.map((item) => ('content' in item ? item.content : undefined))

describe('project launch documents', () => {
  afterEach(() => {
    vi.useRealTimers()
    resolve.mockReset()
    clearProjectLaunchDocumentReads()
  })

  it('re-reads the notes doc before a launch and leaves other items as saved', async () => {
    resolve.mockImplementation(async (request: ResolveContextDocumentRequest) => today(request))

    await refreshProjectLaunchDocuments(project)

    expect(resolve).toHaveBeenCalledWith({ source: 'slite', id: 'notes' })
    expect(contentOf(withFreshProjectDocuments(project))).toEqual(["Today's notes", 'Be brief'])
  })

  it('reuses a recent read and reads again once it is a minute old', async () => {
    resolve.mockImplementation(async (request: ResolveContextDocumentRequest) => today(request))

    await refreshProjectLaunchDocuments(project, 0)
    await refreshProjectLaunchDocuments(project, 30_000)
    expect(resolve).toHaveBeenCalledTimes(1)
    await refreshProjectLaunchDocuments(project, 61_000)
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('keeps the saved copy when the read fails', async () => {
    resolve.mockResolvedValue({ status: 'error', message: 'Slite is not connected.' })

    await refreshProjectLaunchDocuments(project)

    expect(contentOf(withFreshProjectDocuments(project))).toEqual(['Saved notes', 'Be brief'])
  })

  it('stops waiting on a slow read so the launch is never stuck', async () => {
    vi.useFakeTimers()
    resolve.mockReturnValue(new Promise(() => undefined))

    const waiting = refreshProjectLaunchDocuments(project)
    await vi.advanceTimersByTimeAsync(5_000)

    await expect(waiting).resolves.toBeUndefined()
    expect(contentOf(withFreshProjectDocuments(project))).toEqual(['Saved notes', 'Be brief'])
  })

  it('has nothing to re-read in a project without documents', () => {
    const plain = {
      ...project,
      settings: { ...project.settings, attachments: [project.settings.attachments[1]] }
    }
    expect(refreshProjectLaunchDocuments(plain)).toBeNull()
    expect(resolve).not.toHaveBeenCalled()
  })
})
