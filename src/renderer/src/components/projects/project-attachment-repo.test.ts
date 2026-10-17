import { describe, expect, it } from 'vitest'
import type { SessionContextAttachment } from '../../../../shared/session-context-attachments'
import { withRepoRelativePath, withRepoRelativePaths } from './project-attachment-repo'

const repos = [{ gitIdentity: 'github.com/acme/app' }, { gitIdentity: 'github.com/acme/docs' }]
const checkouts: Record<string, string> = {
  'github.com/acme/app@local': '/Users/maintainer/app',
  'github.com/acme/docs@local': '/Users/maintainer/docs',
  'github.com/acme/app@ssh:studio': '/home/sal/app'
}
const checkoutOf = (gitIdentity: string, hostId: string) =>
  checkouts[`${gitIdentity}@${hostId}`] ?? null
const file = (uri: string, hostId?: string): SessionContextAttachment => ({
  id: `file:${hostId ?? 'local'}:${uri}`,
  kind: 'file',
  title: uri.split('/').at(-1)!,
  uri,
  ...(hostId ? { hostId } : {})
})

describe('withRepoRelativePath', () => {
  it('stamps a file inside a project repo’s checkout on its host with the path from the root', () => {
    expect(
      withRepoRelativePath(file('/Users/maintainer/app/src/index.ts'), repos, checkoutOf)
    ).toMatchObject({ repo: { gitIdentity: 'github.com/acme/app', path: 'src/index.ts' } })
    expect(
      withRepoRelativePath(file('/home/sal/app/README.md', 'ssh:studio'), repos, checkoutOf).repo
    ).toEqual({ gitIdentity: 'github.com/acme/app', path: 'README.md' })
  })

  it('names the checkout itself with an empty path', () => {
    const folder: SessionContextAttachment = {
      id: 'folder:local:/Users/maintainer/docs',
      kind: 'folder',
      title: 'docs',
      uri: '/Users/maintainer/docs/'
    }
    expect(withRepoRelativePath(folder, repos, checkoutOf).repo).toEqual({
      gitIdentity: 'github.com/acme/docs',
      path: ''
    })
  })

  it('leaves a file outside every checkout, a host without one, and other kinds as they are', () => {
    const outside = file('/Users/maintainer/notes.md')
    expect(withRepoRelativePath(outside, repos, checkoutOf)).toBe(outside)
    const elsewhere = file('/home/sal/docs/guide.md', 'ssh:studio')
    expect(withRepoRelativePath(elsewhere, repos, checkoutOf)).toBe(elsewhere)
    const skill: SessionContextAttachment = { id: 'skill-name:jev', kind: 'skill', title: 'jev' }
    expect(withRepoRelativePath(skill, repos, checkoutOf)).toBe(skill)
  })

  it('keeps a stamp that is already there', () => {
    const stamped = {
      ...file('/Users/maintainer/app/src/index.ts'),
      repo: { gitIdentity: 'github.com/acme/app', path: 'src/index.ts' }
    }
    expect(withRepoRelativePath(stamped, [], checkoutOf)).toBe(stamped)
  })
})

it('stamps every item of a list that it can', () => {
  const items = [file('/Users/maintainer/app/a.ts'), file('/tmp/b.ts')]
  expect(withRepoRelativePaths(items, repos, checkoutOf).map((item) => item.repo?.path)).toEqual([
    'a.ts',
    undefined
  ])
})
