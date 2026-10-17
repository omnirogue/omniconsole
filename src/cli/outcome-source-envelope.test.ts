import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuntimeClient } from './runtime-client'
import { sendRequest } from './runtime/transport'
import { createOrchestrationCompatibilityEnvelope } from './runtime/orchestration-compatibility-envelope'

vi.mock('./runtime/transport', () => ({ sendRequest: vi.fn() }))
const directories: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('outcome source claim transport', () => {
  it.each([
    'sessionChain.outcomeSource',
    'sessionChain.commitOutcomes',
    'sessionChain.attachOutcome'
  ])('retains current-source attestation on %s through RuntimeClient', async (method) => {
    const directory = mkdtempSync(join(tmpdir(), 'outcome-envelope-'))
    directories.push(directory)
    writeFileSync(
      join(directory, 'omni-runtime.json'),
      JSON.stringify({
        runtimeId: 'runtime',
        pid: process.pid,
        transports: [{ kind: 'unix', endpoint: join(directory, 'runtime.sock') }],
        authToken: 'test-token',
        startedAt: 1
      })
    )
    vi.stubEnv('ORCA_AGENT_LAUNCH_TOKEN', 'test-current-source-claim')
    vi.stubEnv('ORCA_PANE_KEY', 'source-pane')
    vi.mocked(sendRequest).mockResolvedValue({
      id: 'rpc',
      ok: true,
      result: {},
      _meta: { runtimeId: 'runtime' }
    })
    const client = new RuntimeClient(directory, 500, null, null)
    await client.call(
      method,
      { paneKey: 'source-pane' },
      createOrchestrationCompatibilityEnvelope(process.env)
    )
    const sent = JSON.stringify(vi.mocked(sendRequest).mock.calls)
    expect(sent).toContain('test-current-source-claim')
    expect(sent).toContain('orchestrationCompatibilityEvidence')
  })
})
