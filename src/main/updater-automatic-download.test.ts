import { describe, expect, it } from 'vitest'
import { shouldAutomaticallyDownloadUpdate } from './updater-automatic-download'

describe('automatic desktop downloads', () => {
  const release = {
    source: 'release',
    interactive: true,
    manualInstall: false,
    pinnedBuild: false
  } as const
  it.each(['darwin', 'win32'] as const)(
    'downloads official %s updates automatically',
    (platform) => {
      expect(shouldAutomaticallyDownloadUpdate({ ...release, platform })).toBe(true)
    }
  )
  it.each([
    { platform: 'linux' },
    { platform: 'darwin', manualInstall: true },
    { platform: 'win32', interactive: false },
    { platform: 'darwin', source: 'local' },
    { platform: 'win32', pinnedBuild: true }
  ] as const)('retains explicit installation for %o', (options) => {
    expect(shouldAutomaticallyDownloadUpdate({ ...release, ...options })).toBe(false)
  })
})
