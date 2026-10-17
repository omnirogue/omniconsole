import { describe, expect, it, vi } from 'vitest'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import { listSessionProjects, PROJECT_LIST_OLDER_WINDOW, projectThreadCounts } from './project-list'

const row = (fields: Partial<SessionManageSidebarRow>) =>
  ({ folded: false, archived: false, ...fields }) as SessionManageSidebarRow

describe('projectThreadCounts', () => {
  it('counts threads by status with the chat apart, as the project page does', () => {
    expect(
      projectThreadCounts([
        row({ projectThread: { status: 'needsYou', coordinator: true }, archived: true }),
        row({ projectThread: { status: 'working', coordinator: false } }),
        row({ projectThread: { status: 'working', coordinator: false } }),
        row({ projectThread: { status: null, coordinator: false } }),
        row({ projectThread: { status: 'done', coordinator: false }, archived: true }),
        row({ projectThread: { status: 'working', coordinator: false }, folded: true }),
        row({})
      ])
    ).toEqual({ total: 3, byStatus: { working: 2, idle: 1 }, chat: 'needsYou' })
  })
})

describe('listSessionProjects', () => {
  const ads = { folderId: 'p-1', name: 'Ads', path: 'Ads', repos: 2 }
  const seo = { folderId: 'p-2', name: 'SEO', path: 'SEO', repos: 0 }

  it("lists the window's projects with their threads, and null where they can't be counted", async () => {
    const readProjectRows = vi.fn(async (id: string) => {
      if (id === 'p-2') {
        throw new Error('Project thread listing requires an updated OmniConsole window.')
      }
      return [row({ projectThread: { status: 'reviewReady', coordinator: false } })]
    })
    await expect(
      listSessionProjects({
        requestSessionFolders: async () => ({ projects: [ads, seo] }),
        readProjectRows
      })
    ).resolves.toEqual({
      projects: [
        { ...ads, threads: { total: 1, byStatus: { reviewReady: 1 } } },
        { ...seo, threads: null }
      ]
    })
  })

  it('names the reload when an older window does not know the request', async () => {
    await expect(
      listSessionProjects({
        requestSessionFolders: async () => undefined,
        readProjectRows: async () => []
      })
    ).rejects.toThrow(PROJECT_LIST_OLDER_WINDOW)
  })
})
