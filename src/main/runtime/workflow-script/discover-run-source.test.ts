import { describe, expect, it, vi } from 'vitest'
import { runProcess } from '../../../shared/child-process/run-process'
import { readDiscoverRunSource } from './discover-run-source'
vi.mock('../../../shared/child-process/run-process', () => ({ runProcess: vi.fn() }))
const commit = 'a'.repeat(40)
function replies(outputs: (string | null)[]) {
  vi.mocked(runProcess).mockReset()
  for (const stdout of outputs) {
    vi.mocked(runProcess).mockResolvedValueOnce({
      code: stdout === null ? 1 : 0,
      stdout: stdout ?? '',
      stderr: '',
      timedOut: false
    } as Awaited<ReturnType<typeof runProcess>>)
  }
}
describe('Discover source frozen at admission', () => {
  it('records the inspected commit and branch, with uncommitted source disclosed', async () => {
    replies([commit, 'main-next', 'https://github.com/omnirogue/omni-ide.git', ' M src/a.ts'])
    expect(await readDiscoverRunSource('/workspace')).toEqual({
      commit,
      branch: 'main-next',
      origin: 'https://github.com/omnirogue/omni-ide.git',
      dirty: true
    })
    expect(runProcess).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/workspace', program: 'git' })
    )
  })
  it('supports a detached local repository', async () => {
    replies([commit, null, null, ''])
    expect(await readDiscoverRunSource('/workspace')).toEqual({
      commit,
      branch: null,
      dirty: false
    })
  })
  it('keeps folder workspaces readable without inventing a Git base', async () => {
    replies([null])
    expect(await readDiscoverRunSource('/folder')).toBeUndefined()
  })
  it('does not persist an origin containing HTTP credentials', async () => {
    replies([commit, 'main-next', 'https://redacted@example.com/repo'])
    expect(await readDiscoverRunSource('/workspace')).toBeUndefined()
  })
})
