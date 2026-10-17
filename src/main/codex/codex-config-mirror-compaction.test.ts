import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { syncSystemConfigIntoManagedCodexHome } from './codex-config-mirror'

it('refreshes native compaction settings in an existing managed home and keeps runtime trust', () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-compaction-config-'))
  const systemHomePath = join(root, 'system')
  const runtimeHomePath = join(root, 'account')
  mkdirSync(systemHomePath)
  mkdirSync(runtimeHomePath)
  const systemPath = join(systemHomePath, 'config.toml')
  const runtimePath = join(runtimeHomePath, 'config.toml')
  const policy =
    'model_auto_compact_token_limit = 150000\nmodel_auto_compact_token_limit_scope = "total"\n'
  const runtimeTrust = '\n[projects."/repo"]\ntrust_level = "trusted"\n'
  try {
    writeFileSync(systemPath, policy)
    writeFileSync(runtimePath, `model_auto_compact_token_limit = 220000\n${runtimeTrust}`)
    syncSystemConfigIntoManagedCodexHome({ systemHomePath, runtimeHomePath })
    const synced = readFileSync(runtimePath, 'utf8')
    expect(synced).toContain(policy)
    expect(synced).not.toContain('model_auto_compact_token_limit = 220000')
    expect(synced).toContain(runtimeTrust)
    expect(readFileSync(systemPath, 'utf8')).toBe(policy)
    syncSystemConfigIntoManagedCodexHome({ systemHomePath, runtimeHomePath })
    expect(readFileSync(runtimePath, 'utf8')).toBe(synced)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
