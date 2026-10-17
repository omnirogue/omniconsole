import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { appMock, isMock } = vi.hoisted(() => ({
  appMock: { isPackaged: true },
  isMock: { dev: false }
}))
vi.mock('electron', () => ({ app: appMock }))
vi.mock('@electron-toolkit/utils', () => ({ is: isMock }))

import { readUpdaterPolicy, readUpdaterPolicyInput } from './read-updater-policy'

describe('readUpdaterPolicyInput', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function makeResources(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'updater-policy-'))
    dirs.push(dir)
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content)
    }
    return dir
  }

  it('reads the release marker and manifest presence from the resources directory', () => {
    const resources = makeResources({
      'app-update.yml': 'provider: generic\n',
      'omni-local-build.json': JSON.stringify({ version: '1.9.4', releaseBuild: false })
    })
    expect(readUpdaterPolicyInput(resources)).toEqual({
      isPackaged: true,
      isDev: false,
      hasUpdateManifest: true,
      releaseBuild: false
    })
  })

  it('reports null marker and manifest facts when the resources directory is unknown', () => {
    expect(readUpdaterPolicyInput(undefined)).toEqual({
      isPackaged: true,
      isDev: false,
      hasUpdateManifest: null,
      releaseBuild: null
    })
  })

  it('treats a marker without the field, or a corrupt marker, as unknown', () => {
    const noField = makeResources({ 'omni-local-build.json': JSON.stringify({ version: '1.9.4' }) })
    const corrupt = makeResources({ 'omni-local-build.json': '{not json' })
    expect(readUpdaterPolicyInput(noField)).toMatchObject({
      hasUpdateManifest: false,
      releaseBuild: null
    })
    expect(readUpdaterPolicyInput(corrupt)).toMatchObject({ releaseBuild: null })
  })
})

describe('readUpdaterPolicy', () => {
  it('falls back to the packaged/dev gates when no resources directory is known', () => {
    expect(readUpdaterPolicy()).toEqual({ updatesEnabled: true })
    isMock.dev = true
    expect(readUpdaterPolicy()).toMatchObject({ updatesEnabled: false, reason: 'dev' })
    isMock.dev = false
  })
})
