import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Store } from '../persistence'
import { readConsoleHandoffAttachment } from './console-handoff-attachment'
import { authorizeExternalPath } from './filesystem-auth'
import { invalidateAuthorizedRootsCache } from './registered-worktree-roots-cache'

const roots: string[] = []
const store = {
  getRepos: () => [],
  getProjectGroups: () => [],
  getFolderWorkspaces: () => [],
  getSettings: () => ({})
} as unknown as Store

async function fixture(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'handoff-attachment-ipc-')))
  roots.push(path)
  return path
}

afterEach(async () => {
  invalidateAuthorizedRootsCache()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('selected attachment access', () => {
  it('requires a selected folder grant, then captures its contents through that same grant', async () => {
    const root = join(await fixture(), 'selected')
    await mkdir(root)
    await writeFile(join(root, 'plan.md'), '# Private plan')
    const refused = await readConsoleHandoffAttachment({ filePath: root }, store)
    expect(refused).toMatchObject({ ok: false, error: { code: 'file_unavailable' } })
    authorizeExternalPath(root)
    const result = await readConsoleHandoffAttachment({ filePath: root }, store)
    expect(result).toMatchObject({ ok: true, data: { name: 'selected.tar.gz' } })
  })

  it('does not extend a file grant to its unselected sibling', async () => {
    const root = await fixture()
    const selected = join(root, 'selected.md')
    const sibling = join(root, 'other.md')
    await writeFile(selected, '# Selected')
    await writeFile(sibling, '# Not selected')
    authorizeExternalPath(selected)
    expect(await readConsoleHandoffAttachment({ filePath: selected }, store)).toMatchObject({
      ok: true
    })
    expect(await readConsoleHandoffAttachment({ filePath: sibling }, store)).toMatchObject({
      ok: false
    })
  })

  it('refuses a missing SSH owner even if the same local path has a grant', async () => {
    const filePath = join(await fixture(), 'selected.md')
    await writeFile(filePath, 'local bytes are not the remote attachment')
    authorizeExternalPath(filePath)
    expect(
      await readConsoleHandoffAttachment({ filePath, connectionId: 'missing-host' }, store)
    ).toMatchObject({ ok: false })
  })

  it.skipIf(process.platform === 'win32')(
    'refuses selected symlinks instead of inheriting their target grant',
    async () => {
      const root = await fixture()
      const actual = join(root, 'actual')
      await mkdir(actual)
      await writeFile(join(actual, 'plan.md'), '# Real folder')
      const link = join(root, 'link')
      await symlink(actual, link)
      authorizeExternalPath(link)
      const result = await readConsoleHandoffAttachment({ filePath: link }, store)
      expect(result).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining('symbolic links') }
      })
    }
  )

  it('rejects malformed attachment arguments before any local fallback', async () => {
    for (const args of [
      { filePath: '' },
      { filePath: '/path', connectionId: '' },
      { filePath: '/path', arbitrary: true }
    ]) {
      expect(await readConsoleHandoffAttachment(args, store)).toMatchObject({
        ok: false,
        error: { code: 'invalid_request' }
      })
    }
  })
})
