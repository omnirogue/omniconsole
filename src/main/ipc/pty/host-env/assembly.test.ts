import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { omniConsoleMcpLedgerHeaders } from '../../../../shared/mcp-config'
import {
  OMNI_LEDGER_ATTEMPT_ID_ENV,
  OMNI_LEDGER_SESSION_ID_ENV
} from '../../../../shared/session-ledger-env'
import { buildPtyHostEnv } from './assembly'
// Why: a Claude spawn here must not write this machine's real Claude config.
vi.mock('../../../claude-accounts/claude-diff-panel-pty', () => ({
  keepClaudeDiffPanelClosedForPty: vi.fn()
}))

vi.mock('../../../git/runner', () => ({
  gitExecFileAsync: vi.fn(async () => {
    throw new Error('not a repository')
  })
}))
vi.mock('../../../mcp/omni-console-mcp-launch-context', () => ({
  isOmniConsoleMcpDefaultRequested: () => false
}))
vi.mock('../../../backoffice/console-workflow-person', () => ({
  currentConsolePublicationScope: () => null
}))

const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'
let userDataPath: string

beforeAll(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'omni-ledger-env-'))
})

afterAll(() => {
  rmSync(userDataPath, { recursive: true, force: true })
})

function spawnEnv(id: string, baseEnv: Record<string, string>): Record<string, string> {
  return buildPtyHostEnv(id, baseEnv, {
    isPackaged: true,
    userDataPath,
    cwd: userDataPath,
    selectedCodexHomePath: null,
    agentStatusHooksEnabled: false,
    launchAgent: 'claude'
  })
}

describe('session ledger env stamping', () => {
  it('stamps both ledger ids into a pane spawn', () => {
    const env = spawnEnv('pty-ledger-1', { ORCA_PANE_KEY: PANE })
    expect(env[OMNI_LEDGER_SESSION_ID_ENV]).toMatch(/^als_[a-f0-9]{24}$/)
    expect(env[OMNI_LEDGER_ATTEMPT_ID_ENV]).toMatch(/^att_[a-f0-9]{16}$/)
  })

  it('names exactly the env vars the connector config references', () => {
    const env = spawnEnv('pty-ledger-2', { ORCA_PANE_KEY: PANE })
    for (const style of ['claude', 'codex', 'gemini', 'grok'] as const) {
      for (const reference of Object.values(omniConsoleMcpLedgerHeaders(style))) {
        const name = reference.replace(/^\$\{|(:-)?\}$/g, '')
        expect([OMNI_LEDGER_SESSION_ID_ENV, OMNI_LEDGER_ATTEMPT_ID_ENV]).toContain(name)
        expect(env[name]).toMatch(/^(als|att)_[a-f0-9]+$/)
      }
    }
  })

  it('keeps the ledger id and mints a new attempt when the same pane respawns', () => {
    const first = spawnEnv('pty-ledger-3', { ORCA_PANE_KEY: PANE })
    const second = spawnEnv('pty-ledger-4', { ORCA_PANE_KEY: PANE })
    expect(second[OMNI_LEDGER_SESSION_ID_ENV]).toBe(first[OMNI_LEDGER_SESSION_ID_ENV])
    expect(second[OMNI_LEDGER_ATTEMPT_ID_ENV]).not.toBe(first[OMNI_LEDGER_ATTEMPT_ID_ENV])
  })

  it('never lets a nested terminal inherit its parent pane ids, and stamps nothing without a pane', () => {
    const env = spawnEnv('pty-ledger-5', {
      [OMNI_LEDGER_SESSION_ID_ENV]: 'als_ffffffffffffffffffffffff',
      [OMNI_LEDGER_ATTEMPT_ID_ENV]: 'att_ffffffffffffffff'
    })
    expect(env[OMNI_LEDGER_SESSION_ID_ENV]).toBeUndefined()
    expect(env[OMNI_LEDGER_ATTEMPT_ID_ENV]).toBeUndefined()
  })
})
