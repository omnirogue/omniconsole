import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseArgs, validateCommandAndFlags } from '../args'
import type { HandlerContext } from '../dispatch'
import { CORE_COMMAND_SPECS } from '../specs/core'
import { REPO_HANDLERS } from './repo'

vi.mock('../format', () => ({
  formatRepoList: vi.fn(),
  formatRepoRefs: vi.fn(),
  formatRepoShow: vi.fn(),
  printResult: vi.fn()
}))

const call = vi.fn()

async function addRepo(args: string[], isRemote = false): Promise<void> {
  const parsed = parseArgs(['repo', 'add', ...args])
  validateCommandAndFlags(CORE_COMMAND_SPECS, parsed)
  await REPO_HANDLERS['repo add']({
    flags: parsed.flags,
    client: { call, isRemote } as unknown as HandlerContext['client'],
    cwd: '/client/projects',
    json: true
  })
}

describe('repo add project kind', () => {
  beforeEach(() => {
    call.mockReset().mockResolvedValue({ result: { repo: { id: 'repo-1' } } })
  })

  it('preserves the default Git registration request when kind is omitted', async () => {
    await addRepo(['--path', './app'])

    expect(call).toHaveBeenCalledExactlyOnceWith('repo.add', {
      path: resolve('/client/projects', './app')
    })
  })

  it.each(['git', 'folder'])('registers an explicit %s project', async (kind) => {
    await addRepo(['--path', './app', '--kind', kind])

    expect(call).toHaveBeenCalledExactlyOnceWith('repo.add', {
      path: resolve('/client/projects', './app'),
      kind
    })
  })

  it.each(['/worker/jobs/folder job', String.raw`C:\worker\folder job`])(
    'preserves the execution host folder path %s',
    async (path) => {
      await addRepo(['--path', path, '--kind', 'folder'], true)

      expect(call).toHaveBeenCalledExactlyOnceWith('repo.add', { path, kind: 'folder' })
    }
  )

  it('rejects relative remote folder paths before registration', async () => {
    await expect(addRepo(['--path', './folder', '--kind', 'folder'], true)).rejects.toThrow(
      'Remote repo add requires --path to be an absolute path on the remote server.'
    )

    expect(call).not.toHaveBeenCalled()
  })

  it.each([['--kind', 'unknown'], ['--kind'], ['--kind=']])(
    'rejects invalid kind arguments %j before registration',
    async (...kindArgs) => {
      await expect(addRepo(['--path', './folder', ...kindArgs])).rejects.toMatchObject({
        code: 'invalid_argument'
      })

      expect(call).not.toHaveBeenCalled()
    }
  )
})
