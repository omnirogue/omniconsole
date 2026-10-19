import { afterEach, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TeamConfigTargets } from './config-targets'
import {
  rememberConnectorChoice,
  updateTeamConnectorConfig
} from '../mcp/connector-config-preservation'

const directory = mkdtempSync(join(tmpdir(), 'omnisi-targets-'))
afterEach(() => rmSync(directory, { recursive: true, force: true }))
it('removes a recorded account destination even after it disappears from account settings', () => {
  const file = join(directory, 'removed-account', 'config.toml')
  const manifest = join(directory, 'config-targets.json')
  const targets = new TeamConfigTargets(manifest)
  targets.remember({ file, provider: 'codex', home: join(directory, 'removed-account') })
  updateTeamConnectorConfig(file, 'codex', 'https://team.example/mcp')
  rememberConnectorChoice(join(directory, 'removed-account'), 'omnisi-team', 'keep')
  targets.clear()
  expect(readFileSync(file, 'utf8')).not.toContain('omnisi-team')
  expect(existsSync(join(directory, 'removed-account', '.omni-mcp-account-overrides.json')))
    .toBe(false)
  expect(existsSync(manifest)).toBe(false)
})
