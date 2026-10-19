import { describe, expect, it } from 'vitest'
import { publishablePath, REDACTED_PATH, stripUsernameFromPath } from './ledger-path-privacy'

describe('username stripping', () => {
  it.each([
    ['/Users/maintainer/Work/repo/src/a.ts', '~/Work/repo/src/a.ts'],
    ['/home/uma/repo/b.py', '~/repo/b.py'],
    ['C:\\Users\\Sal Baker\\repo\\c.ts', '~/repo/c.ts'],
    ['C:/Users/maintainer/repo/d.ts', '~/repo/d.ts'],
    ['c:/users/alice/repo/d.ts', '~/repo/d.ts'],
    ['c:\\users\\alice\\repo\\d.ts', '~/repo/d.ts'],
    ['/mnt/c/Users/alice/repo/e.ts', '~/repo/e.ts'],
    ['/mnt/d/users/alice/repo/e.ts', '~/repo/e.ts'],
    ['//wsl$/Ubuntu/home/alice/repo/g.ts', '~/repo/g.ts'],
    ['//wsl.localhost/Ubuntu/home/alice/repo/g.ts', '~/repo/g.ts'],
    ['/root/repo/h.ts', '~/repo/h.ts'],
    ['/Users/maintainer', '~/'],
    ['/home/sal', '~/'],
    ['/opt/shared/e.ts', '/opt/shared/e.ts'],
    ['relative/f.ts', 'relative/f.ts']
  ])('%s → %s', (input, expected) => {
    expect(stripUsernameFromPath(input)).toBe(expected)
  })

  it('never leaves a home-directory username in a published path', () => {
    for (const path of [
      '/Users/maintainer/x',
      '/home/sal/x',
      '/root/x',
      'C:\\Users\\sal\\x',
      'c:/users/sal/x',
      '/mnt/c/Users/maintainer/x',
      '/mnt/c/users/sal/x',
      '//wsl$/Ubuntu/home/sal/x',
      '/Users/maintainer'
    ]) {
      expect(publishablePath(path)).not.toContain('sal')
    }
  })

  it('fails closed when a home-shaped segment survives stripping', () => {
    expect(publishablePath('/Users/maintainer/Users/other/x.ts')).toBe(REDACTED_PATH)
    expect(publishablePath('/srv/home/sal/x.ts')).toBe(REDACTED_PATH)
    expect(publishablePath('/Users/maintainer/repo/home/other/x.ts', '/Users/maintainer/repo')).toBe(
      REDACTED_PATH
    )
    expect(publishablePath('/Users/maintainer/repo/src/home.ts', '/Users/maintainer/repo')).toBe('src/home.ts')
  })
})

describe('publishable paths', () => {
  it('is repo-relative inside the workspace root', () => {
    expect(publishablePath('/Users/maintainer/repo/src/a.ts', '/Users/maintainer/repo')).toBe('src/a.ts')
    expect(publishablePath('/Users/maintainer/repo/src/a.ts', '/Users/maintainer/repo/')).toBe('src/a.ts')
    expect(publishablePath('C:\\Users\\sal\\repo\\src\\a.ts', 'C:\\Users\\sal\\repo')).toBe(
      'src/a.ts'
    )
  })

  it('does not treat a sibling directory prefix as inside the root', () => {
    expect(publishablePath('/Users/maintainer/repo-two/a.ts', '/Users/maintainer/repo')).toBe('~/repo-two/a.ts')
  })

  it('caps the published length at the contract limit, keeping the tail', () => {
    const long = `/Users/maintainer/${'d/'.repeat(200)}leaf.ts`
    const published = publishablePath(long)
    expect(published.length).toBeLessThanOrEqual(300)
    expect(published.endsWith('leaf.ts')).toBe(true)
  })
})
