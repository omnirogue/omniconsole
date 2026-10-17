import { beforeEach, expect, it, vi } from 'vitest'
import { manageEntry, sidebarRow } from '../session-manage/session-manage-test-fixtures'
const { observe } = vi.hoisted(() => ({ observe: vi.fn() }))
vi.mock('../session-manage/session-manage-inventory', () => ({ observeSessionManageRows: observe }))
vi.mock('../session-manage/session-manage-runtime-sources', () => ({
  createRuntimeObserveSources: () => ({})
}))
vi.mock('../session-manage/session-manage-owner-runtime', () => ({
  runtimeChainBound: () => false
}))
import { assertSessionPrepReuseWorkspace } from './session-prep-reuse-workspace'

const target = sidebarRow({ paneKey: 'owner', worktreePath: '/src', hostId: 'local' })
const scan = vi.fn()
const runtime = { scanWorkspacePorts: scan } as never
beforeEach(() => {
  observe.mockReset().mockResolvedValue([])
  scan.mockReset().mockResolvedValue({ ports: [] })
})
it('refuses a serving checkout before resuming or assigning', async () => {
  scan.mockResolvedValue({ ports: [{ kind: 'workspace', owner: { path: '/src' } }] })
  await expect(
    assertSessionPrepReuseWorkspace(runtime, [target], { paneKey: 'owner' })
  ).rejects.toThrow('serving')
})
it('holds when the serving check is unavailable', async () => {
  scan.mockResolvedValue({ ports: [], unavailableReason: 'permission denied' })
  await expect(
    assertSessionPrepReuseWorkspace(runtime, [target], { paneKey: 'owner' })
  ).rejects.toThrow('unavailable')
})
it.each(['live', 'unverifiable'] as const)(
  'refuses another writer whose verdict is %s, including an archived row',
  async (verdict) => {
    const writer = sidebarRow({ paneKey: 'writer', worktreePath: '/src', archived: true })
    observe.mockResolvedValue([{ row: writer, entry: manageEntry({ verdict, state: 'working' }) }])
    await expect(
      assertSessionPrepReuseWorkspace(runtime, [target, writer], { paneKey: 'owner' })
    ).rejects.toThrow('not verified idle')
    expect(observe.mock.calls[0]?.[0]).toContain(writer)
    expect(scan).not.toHaveBeenCalled()
  }
)
it('supports a closed conversation in a local folder workspace and ignores another host', async () => {
  const remote = sidebarRow({ paneKey: 'remote', worktreePath: '/src', hostId: 'remote' })
  await assertSessionPrepReuseWorkspace(runtime, [remote], { paneKey: 'closed-ref', cwd: '/src' })
  expect(observe.mock.calls[0]?.[0]).toEqual([])
})

it('checks the actual transcript folder when the archived index has a stale cwd', async () => {
  scan.mockResolvedValue({ ports: [{ kind: 'workspace', owner: { path: '/actual' } }] })
  await expect(
    assertSessionPrepReuseWorkspace(
      runtime,
      [target],
      { paneKey: 'owner', cwd: '/indexed' },
      '/actual'
    )
  ).rejects.toThrow('serving')
})
