import { describe, expect, it } from 'vitest'
import {
  isOmniConsoleCliLauncherPath,
  reconcileOmniConsoleCliDetection
} from './omniconsole-cli-detection'

const BUNDLED = '/Users/maintainer/Applications/OmniConsole.app/Contents/Resources/bin/omni'
const PYENV = '/Users/maintainer/.pyenv/versions/3.12.1/bin/omni'

function deps(overrides: Partial<Parameters<typeof reconcileOmniConsoleCliDetection>[1]>) {
  return {
    platform: 'darwin' as const,
    launcher: null,
    resolveCommandPath: async () => null,
    realpath: async (candidate: string) => candidate,
    ...overrides
  }
}

describe('isOmniConsoleCliLauncherPath', () => {
  it('accepts the packaged launcher and the dev launcher only', () => {
    expect(isOmniConsoleCliLauncherPath(BUNDLED)).toBe(true)
    expect(isOmniConsoleCliLauncherPath('/Applications/Orca.app/Contents/MacOS/omni')).toBe(true)
    expect(isOmniConsoleCliLauncherPath('/home/sal/.config/omni-dev/cli/bin/omni-dev')).toBe(true)
    expect(isOmniConsoleCliLauncherPath(PYENV)).toBe(false)
    expect(isOmniConsoleCliLauncherPath('/home/sal/cli/bin/omni')).toBe(false)
    expect(isOmniConsoleCliLauncherPath('/usr/local/bin/omni')).toBe(false)
    expect(
      isOmniConsoleCliLauncherPath('/Applications/Foo.app/Contents/Resources/bin/claude')
    ).toBe(false)
  })
})

describe('reconcileOmniConsoleCliDetection', () => {
  it('counts a bundled launcher as present even when PATH has no omni', async () => {
    const found = await reconcileOmniConsoleCliDetection(
      new Set(['claude']),
      deps({ launcher: BUNDLED })
    )
    expect([...found].sort()).toEqual(['claude', 'omni'])
  })

  it('drops a PATH omni that is a namesake, not the OmniConsole CLI', async () => {
    const found = await reconcileOmniConsoleCliDetection(
      new Set(['claude', 'omni']),
      deps({ resolveCommandPath: async () => PYENV })
    )
    expect([...found]).toEqual(['claude'])
  })

  it('keeps a registered PATH omni that resolves into the app bundle', async () => {
    const found = await reconcileOmniConsoleCliDetection(
      new Set(['claude', 'omni']),
      deps({
        resolveCommandPath: async () => '/usr/local/bin/omni',
        realpath: async () => BUNDLED
      })
    )
    expect([...found].sort()).toEqual(['claude', 'omni'])
  })

  it('keeps a bundle path when realpath cannot follow it', async () => {
    const found = await reconcileOmniConsoleCliDetection(
      new Set(['omni']),
      deps({
        resolveCommandPath: async () => '/Applications/Orca.app/Contents/MacOS/omni',
        realpath: async () => {
          throw new Error('ENOENT')
        }
      })
    )
    expect([...found]).toEqual(['omni'])
  })

  it('drops omni when the PATH entry cannot be resolved or is a namesake after realpath fails', async () => {
    expect([...(await reconcileOmniConsoleCliDetection(new Set(['omni']), deps({})))]).toEqual([])
    expect([
      ...(await reconcileOmniConsoleCliDetection(
        new Set(['omni-dev']),
        deps({
          resolveCommandPath: async () => '/usr/local/bin/omni-dev',
          realpath: async () => {
            throw new Error('ENOENT')
          }
        })
      ))
    ]).toEqual([])
  })

  it('leaves other platforms on plain PATH detection', async () => {
    const found = await reconcileOmniConsoleCliDetection(
      new Set(['omni']),
      deps({ platform: 'linux', resolveCommandPath: async () => PYENV })
    )
    expect([...found]).toEqual(['omni'])
  })
})
