import { beforeEach, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'

const state = vi.hoisted(() => ({ launch: vi.fn(), guard: vi.fn() }))
vi.mock('../../../omni-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => '/profile'
}))
vi.mock('../../../session-host-owner/session-host-relocated-away', () => ({
  relocatedAwayRefusal: () => null
}))
vi.mock('../../../session-manage/session-manage-assign-ref', () => ({
  assignByRef: async (deps: { resume(preview: boolean): Promise<unknown> }) => ({
    result: await deps.resume(false)
  })
}))
vi.mock('../../../session-manage/session-manage-resume-runtime', () => ({
  runtimeResumeDeps: () => ({
    readRows: async () => [],
    organization: async () => ({ deleted: false, hidden: false }),
    locate: async () => [{ path: '/transcript', providerRoot: '/provider', defaultRoot: true }],
    transcriptCwd: async () => '/actual-transcript-folder',
    launch: state.launch,
    confirm: async () => ({ state: 'same', paneKey: 'new-pane' }),
    platform: 'darwin',
    hostLabel: 'this Mac'
  })
}))
vi.mock('./session-manage-support', () => ({ recordSessionAction: vi.fn() }))
import { assignByRefOnRuntime } from './session-manage-assign-ref-method'

beforeEach(() => {
  state.guard.mockReset()
  state.launch.mockReset().mockResolvedValue({
    terminal: 'term_actual',
    paneKey: 'new-pane',
    tabId: 'new-tab',
    disposition: 'created'
  })
})
const run = () =>
  assignByRefOnRuntime(
    { runtime: {} } as RpcContext,
    {
      ref: 'claude:12345678-1234-1234-1234-123456789abc@local',
      task: 'Continue parser work',
      reason: 'user chose reuse'
    },
    { kind: 'pane', paneKey: 'request-pane', title: 'Session prep' },
    state.guard
  )
it('checks the actual transcript cwd before reopening a closed conversation', async () => {
  await run()
  expect(state.guard).toHaveBeenCalledTimes(2)
  expect(state.guard).toHaveBeenNthCalledWith(1, '/actual-transcript-folder')
  expect(state.guard).toHaveBeenNthCalledWith(2, '/actual-transcript-folder')
  expect(state.launch).toHaveBeenCalledOnce()
})
it('does not start the old conversation when its actual workspace becomes serving before launch', async () => {
  state.guard.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('serving checkout'))
  await expect(run()).rejects.toThrow('serving checkout')
  expect(state.launch).not.toHaveBeenCalled()
})
