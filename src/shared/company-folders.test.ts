import { describe, expect, it } from 'vitest'
import {
  companyFolderSegment,
  expandHome,
  isValidFolderSetting,
  resolveCompanyFolder,
  resolveDomainFolder
} from './company-folders'

describe('expandHome', () => {
  it('expands a home-rooted path and leaves an absolute one alone', () => {
    expect(expandHome('~/Work', '/Users/maintainer')).toBe('/Users/maintainer/Work')
    expect(expandHome('~', '/Users/maintainer')).toBe('/Users/maintainer')
    expect(expandHome('/srv/work', '/Users/maintainer')).toBe('/srv/work')
  })

  it('expands against a Windows home too', () => {
    expect(expandHome('~/Work', 'C:\\Users\\sal')).toBe('C:/Users/maintainer/Work')
  })

  it('leaves another account’s home verbatim rather than guessing it', () => {
    expect(expandHome('~uma/Work', '/Users/maintainer')).toBe('~uma/Work')
  })
})

describe('isValidFolderSetting', () => {
  it('accepts absolute and home-rooted paths', () => {
    expect(isValidFolderSetting('/Users/maintainer/Work')).toBe(true)
    expect(isValidFolderSetting('~/Work')).toBe(true)
    expect(isValidFolderSetting('C:\\Work')).toBe(true)
  })

  it('refuses empty, relative and traversing values', () => {
    expect(isValidFolderSetting('')).toBe(false)
    expect(isValidFolderSetting('   ')).toBe(false)
    expect(isValidFolderSetting('Work/OmniRogue')).toBe(false)
    expect(isValidFolderSetting('~/Work/../../etc')).toBe(false)
  })
})

describe('resolveCompanyFolder', () => {
  const home = '/Users/maintainer'

  it('follows the estate convention when nothing is configured', () => {
    expect(resolveCompanyFolder({ company: { slug: 'omnirogue', name: 'OmniRogue' }, home })).toBe(
      '/Users/maintainer/Work/OmniRogue'
    )
  })

  it('honours a custom work root', () => {
    expect(
      resolveCompanyFolder({
        workRoot: '/srv/estate',
        company: { slug: 'apexlabs', name: 'ApexLabs' },
        home
      })
    ).toBe('/srv/estate/ApexLabs')
  })

  it('prefers a per-company override, expanded', () => {
    expect(
      resolveCompanyFolder({
        workRoot: '~/Work',
        overrides: { omnirogue: '~/Code/omnirogue' },
        company: { slug: 'omnirogue', name: 'OmniRogue' },
        home
      })
    ).toBe('/Users/maintainer/Code/omnirogue')
  })

  it('falls back to the slug when the company has no display name', () => {
    expect(resolveCompanyFolder({ company: { slug: 'acme' }, home })).toBe('/Users/maintainer/Work/acme')
  })
})

describe('resolveDomainFolder', () => {
  it('uses the department’s display name verbatim', () => {
    expect(resolveDomainFolder('/Users/maintainer/Work/ApexLabs', 'Customer Service')).toBe(
      '/Users/maintainer/Work/ApexLabs/Customer Service'
    )
  })

  it('never lets a name escape the company folder', () => {
    expect(companyFolderSegment('../etc')).toBe('..-etc')
    expect(resolveDomainFolder('/Users/maintainer/Work/ApexLabs', '..')).toBe(
      '/Users/maintainer/Work/ApexLabs/--'
    )
  })

  it('returns the company folder when the department has no name', () => {
    expect(resolveDomainFolder('/Users/maintainer/Work/ApexLabs', '  ')).toBe(
      '/Users/maintainer/Work/ApexLabs'
    )
  })
})
