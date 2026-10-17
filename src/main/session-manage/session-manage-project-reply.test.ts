import { describe, expect, it, vi } from 'vitest'
import { readSidebarRows } from './session-manage-runtime-actions'

describe('project sidebar projection acknowledgement', () => {
  it('rejects an older window that ignores the project filter', async () => {
    const requestSessionFolders = vi.fn(async () => [])
    await expect(
      readSidebarRows({ requestSessionFolders } as never, {
        projectFolderId: 'project-a'
      })
    ).rejects.toThrow('requires an updated OmniConsole window')
  })

  it('accepts an explicitly acknowledged empty project and refuses another project', async () => {
    const requestSessionFolders = vi.fn(async () => ({ projectFolderId: 'project-a', rows: [] }))
    await expect(
      readSidebarRows({ requestSessionFolders } as never, {
        projectFolderId: 'project-a'
      })
    ).resolves.toEqual([])
    await expect(
      readSidebarRows({ requestSessionFolders } as never, {
        projectFolderId: 'project-b'
      })
    ).rejects.toThrow('requires an updated OmniConsole window')
  })

  it('preserves the ordinary row-list reply for older callers', async () => {
    const rows = [{ rowKey: 'row' }]
    const requestSessionFolders = vi.fn(async () => rows)
    await expect(readSidebarRows({ requestSessionFolders } as never)).resolves.toBe(rows)
    expect(requestSessionFolders).toHaveBeenCalledWith({ kind: 'listSessions' })
  })
})
