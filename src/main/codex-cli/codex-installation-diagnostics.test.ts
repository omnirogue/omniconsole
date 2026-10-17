import {
  mkdirSync,
  symlinkSync,
  writeFileSync,
  chmodSync,
  realpathSync,
  mkdtempSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { describeCodexInstallation } from './codex-installation-diagnostics'

function layout(): {
  root: string
  pathBin: string
  nodeBin: string
  npmPrefix: string
} {
  const root = mkdtempSync(join(tmpdir(), 'codex-install-diag-'))
  const pathBin = join(root, '.local', 'bin')
  const nodeBin = join(root, '.local', 'node', 'bin')
  const npmPrefix = join(root, '.local', 'opt', 'node')
  for (const dir of [pathBin, nodeBin, join(npmPrefix, 'bin')]) {
    mkdirSync(dir, { recursive: true })
  }
  const oldCodex = join(nodeBin, 'codex')
  writeFileSync(oldCodex, '#!/bin/sh\necho codex-cli 0.153.0\n')
  chmodSync(oldCodex, 0o755)
  symlinkSync(oldCodex, join(pathBin, 'codex'))
  const newCodex = join(npmPrefix, 'bin', 'codex')
  writeFileSync(newCodex, '#!/bin/sh\necho codex-cli 0.154.0\n')
  chmodSync(newCodex, 0o755)
  return { root, pathBin, nodeBin, npmPrefix }
}

describe.skipIf(process.platform === 'win32')('describeCodexInstallation', () => {
  it('reports the laptop shape: PATH symlink to an old copy, updater targeting another prefix', async () => {
    const fixture = layout()
    const versions: Record<string, string> = {
      [realpathSync(join(fixture.nodeBin, 'codex'))]: '0.153.0',
      [realpathSync(join(fixture.npmPrefix, 'bin', 'codex'))]: '0.154.0'
    }
    const result = await describeCodexInstallation({
      resolveEnvironment: async () => ({ PATH: fixture.pathBin, HOME: fixture.root }),
      runVersion: async (program) => versions[realpathSync(program)] ?? null,
      runNpmPrefix: async () => fixture.npmPrefix,
      platform: 'darwin',
      now: () => 42
    })
    expect(result.command).toBe(join(fixture.pathBin, 'codex'))
    expect(result.realPath).toBe(realpathSync(join(fixture.nodeBin, 'codex')))
    expect(result.version).toBe('0.153.0')
    expect(result.npmGlobalPrefix).toBe(fixture.npmPrefix)
    expect(result.npmGlobalCodexPath).toBe(join(fixture.npmPrefix, 'bin', 'codex'))
    expect(result.npmGlobalCodexVersion).toBe('0.154.0')
    expect(result.updateTargetDiverges).toBe(true)
    expect(result.checkedAt).toBe(42)
  })

  it('is quiet when the launched binary is the npm-managed one', async () => {
    const fixture = layout()
    const result = await describeCodexInstallation({
      resolveEnvironment: async () => ({
        PATH: join(fixture.npmPrefix, 'bin'),
        HOME: fixture.root
      }),
      runVersion: async () => '0.154.0',
      runNpmPrefix: async () => fixture.npmPrefix,
      platform: 'darwin'
    })
    expect(result.updateTargetDiverges).toBe(false)
    expect(result.npmGlobalCodexVersion).toBe('0.154.0')
  })

  it('never claims divergence when npm or the binary cannot be found', async () => {
    const result = await describeCodexInstallation({
      resolveEnvironment: async () => ({ PATH: '/nonexistent-dir-for-test', HOME: tmpdir() }),
      runVersion: async () => null,
      runNpmPrefix: async () => null,
      platform: 'darwin'
    })
    expect(result.command).toBe('codex')
    expect(result.realPath).toBeNull()
    expect(result.updateTargetDiverges).toBe(false)
  })
})
