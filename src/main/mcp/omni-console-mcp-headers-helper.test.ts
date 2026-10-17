import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  omniConsoleMcpHeadersHelperPath,
  resolveOmniConsoleMcpHeadersHelperCommand
} from './omni-console-mcp-headers-helper'

const SHIPPED_HELPER = join(process.cwd(), 'resources', 'mcp', 'omni-console-mcp-headers.sh')

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omni-mcp-helper-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

// Why: fixtures live under the OS temp dir, which the resolver refuses by default (F1).
const temporaryRoots: string[] = []

function placeHelper(dir: string, mode = 0o755): string {
  const path = join(dir, 'mcp', 'omni-console-mcp-headers.sh')
  mkdirSync(join(dir, 'mcp'), { recursive: true })
  writeFileSync(path, '#!/bin/sh\n')
  chmodSync(path, mode)
  return path
}

describe('omni-console MCP headers helper location', () => {
  it('uses Resources/mcp in a packaged app and <app>/resources/mcp in dev', () => {
    expect(
      omniConsoleMcpHeadersHelperPath({ isPackaged: true, resourcesPath: '/App/Resources' })
    ).toBe('/App/Resources/mcp/omni-console-mcp-headers.sh')
    expect(omniConsoleMcpHeadersHelperPath({ isPackaged: false, appPath: '/repo' })).toBe(
      '/repo/resources/mcp/omni-console-mcp-headers.sh'
    )
    expect(omniConsoleMcpHeadersHelperPath({ isPackaged: true, resourcesPath: null })).toBeNull()
    expect(omniConsoleMcpHeadersHelperPath({ isPackaged: false, appPath: 'relative' })).toBeNull()
  })

  it.skipIf(process.platform === 'win32')('resolves an executable helper to its command', () => {
    const resources = join(root, 'Resources')
    const path = placeHelper(resources)
    expect(
      resolveOmniConsoleMcpHeadersHelperCommand({
        isPackaged: true,
        resourcesPath: resources,
        platform: 'darwin',
        temporaryRoots
      })
    ).toBe(path)
    const devRoot = join(root, 'dev')
    const devPath = placeHelper(join(devRoot, 'resources'))
    expect(
      resolveOmniConsoleMcpHeadersHelperCommand({
        isPackaged: false,
        appPath: devRoot,
        platform: 'linux',
        temporaryRoots
      })
    ).toBe(devPath)
  })

  it.skipIf(process.platform === 'win32')(
    'returns null so the legacy shape stays when the helper cannot run',
    () => {
      const resources = join(root, 'Resources')
      const location = {
        isPackaged: true,
        resourcesPath: resources,
        platform: 'darwin' as const,
        temporaryRoots
      }
      expect(resolveOmniConsoleMcpHeadersHelperCommand(location)).toBeNull()
      placeHelper(resources, 0o644)
      expect(resolveOmniConsoleMcpHeadersHelperCommand(location)).toBeNull()
      placeHelper(resources)
      expect(resolveOmniConsoleMcpHeadersHelperCommand(location)).not.toBeNull()
      expect(
        resolveOmniConsoleMcpHeadersHelperCommand({ ...location, platform: 'win32' })
      ).toBeNull()
      const translocated = join(root, 'AppTranslocation', 'Resources')
      placeHelper(translocated)
      expect(
        resolveOmniConsoleMcpHeadersHelperCommand({ ...location, resourcesPath: translocated })
      ).toBeNull()
    }
  )

  // F1: an AppImage FUSE mount (`/tmp/.mount_<name><rand>`) vanishes when the app exits; a
  // persisted helper path there exits 127 and Claude drops the ledger headers silently.
  it.skipIf(process.platform === 'win32')(
    'refuses a Linux AppImage mount so the legacy headers shape stays',
    () => {
      const resources = join(root, '.mount_omniABC123', 'resources')
      placeHelper(resources)
      expect(
        resolveOmniConsoleMcpHeadersHelperCommand({
          isPackaged: true,
          resourcesPath: resources,
          platform: 'linux',
          temporaryRoots
        })
      ).toBeNull()
    }
  )

  it.skipIf(process.platform === 'win32')(
    'refuses a helper under the system temp directory by default',
    () => {
      const resources = join(root, 'Resources')
      placeHelper(resources)
      const location = { isPackaged: true, resourcesPath: resources, platform: 'linux' as const }
      expect(
        resolveOmniConsoleMcpHeadersHelperCommand({ ...location, temporaryRoots })
      ).not.toBeNull()
      expect(resolveOmniConsoleMcpHeadersHelperCommand(location)).toBeNull()
    }
  )
})

describe.skipIf(process.platform === 'win32')('shipped omni-console MCP headers helper', () => {
  const run = (env: NodeJS.ProcessEnv): unknown => {
    // Claude Code runs the helper with cwd = the config directory; nothing may depend on cwd.
    const result = spawnSync(SHIPPED_HELPER, [], { cwd: root, env, encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    return JSON.parse(result.stdout)
  }

  it('prints the pane ledger ids as the two headers', () => {
    expect(
      run({
        PATH: process.env.PATH,
        OMNI_LEDGER_SESSION_ID: 'als_aaaaaaaa',
        OMNI_LEDGER_ATTEMPT_ID: 'att_11111111'
      })
    ).toEqual({ 'X-Omni-Ledger-Session': 'als_aaaaaaaa', 'X-Omni-Ledger-Attempt': 'att_11111111' })
  })

  it('prints empty values outside the IDE, even with no PATH', () => {
    expect(run({})).toEqual({ 'X-Omni-Ledger-Session': '', 'X-Omni-Ledger-Attempt': '' })
  })

  it('JSON-escapes hostile values', () => {
    expect(
      run({
        PATH: process.env.PATH,
        OMNI_LEDGER_SESSION_ID: 'a"b\\c',
        OMNI_LEDGER_ATTEMPT_ID: 'x\ty\nz'
      })
    ).toEqual({ 'X-Omni-Ledger-Session': 'a"b\\c', 'X-Omni-Ledger-Attempt': 'xyz' })
  })
})
