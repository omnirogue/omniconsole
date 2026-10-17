import { afterEach, expect, it, vi } from 'vitest'
import { ghExecFileAsync, gitExecFileAsync } from '../../../github/gh-utils'

vi.mock('../../../github/gh-utils', () => ({
  acquire: async () => {},
  release: () => {},
  ghExecFileAsync: vi.fn(async () => ({ stdout: '1', stderr: '' })),
  gitExecFileAsync: vi.fn(async () => ({ stdout: 'commit', stderr: '' }))
}))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

it('uses the patched launch PATH even when imported before application startup', async () => {
  vi.stubEnv('PATH', '/usr/bin:/bin')
  const { cloneWorkflowContextRepo } = await import('./context-github-clone')
  const patched = '/opt/homebrew/bin:/usr/bin:/bin'
  vi.stubEnv('PATH', patched)
  await cloneWorkflowContextRepo({ repo: 'acme/app', ref: 'a'.repeat(40), target: '/tmp/copy' })
  for (const [, options] of vi.mocked(ghExecFileAsync).mock.calls) {
    expect(options?.env).toMatchObject({
      PATH: patched,
      GIT_TERMINAL_PROMPT: '0',
      GIT_LFS_SKIP_SMUDGE: '1'
    })
  }
  expect(ghExecFileAsync).toHaveBeenCalledTimes(2)
  expect(gitExecFileAsync).toHaveBeenCalledWith(
    expect.arrayContaining(['fetch']),
    expect.objectContaining({ env: expect.objectContaining({ PATH: patched }) })
  )
})
