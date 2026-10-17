import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../args'
import type { RuntimeClient } from '../runtime-client'
import { JEV_REQUEST_V2_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import { JEV_HANDLERS } from './jev'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jev-request-cli-'))
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.stubEnv('ORCA_CLI_CWD', '')
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

function request(input: unknown, capabilities: string[], argv: string[] = []) {
  writeFileSync(join(dir, 'request.json'), JSON.stringify(input))
  const parsed = parseArgs(['jev', 'request', '--file', 'request.json', ...argv])
  const call = vi.fn(async (method: string) => ({
    id: 'request',
    ok: true,
    result:
      method === 'status.get'
        ? { capabilities }
        : { schema_version: 'jev-request-record/1', storage: { status: 'saved' } }
  }))
  const run = () =>
    JEV_HANDLERS['jev request']!({
      flags: parsed.flags,
      client: { call } as unknown as RuntimeClient,
      cwd: dir,
      json: true
    })
  return { call, run }
}

const added = [
  { recipeId: 'support_triage', state: { message: 'Fictional: where is my order?' } },
  { recipeId: 'retrieval_review', state: { query: 'refund window', passage: 'Refunds: 14 days.' } },
  {
    recipeId: 'lead_fit',
    state: { lead: 'Fictional bakery, 3 sites', criteria: 'Multi-site food' }
  }
]

describe('omni jev request recipes', () => {
  it.each(added)(
    'sends $recipeId only after the runtime advertises jev.request.v2',
    async (input) => {
      const command = request(input, [JEV_REQUEST_V2_RUNTIME_CAPABILITY], ['--jev', 'off'])
      await command.run()
      expect(command.call.mock.calls.map(([method]) => method)).toEqual([
        'status.get',
        'jev.request'
      ])
      expect(command.call).toHaveBeenLastCalledWith('jev.request', { input, control: 'off' })
    }
  )

  it.each(added)('refuses $recipeId on an older runtime without sending it', async (input) => {
    const command = request(input, ['jev.rubrics.v1'])
    await expect(command.run()).rejects.toMatchObject({
      code: 'unsupported_runtime_capability',
      message: expect.stringContaining('Update that runtime')
    })
    expect(command.call).toHaveBeenCalledExactlyOnceWith('status.get')
  })

  it('keeps the three earlier recipes working against an older runtime', async () => {
    const input = { recipeId: 'work_routing', state: { task: 'Rename a fixture file' } }
    const command = request(input, [])
    await command.run()
    expect(command.call).toHaveBeenCalledExactlyOnceWith('jev.request', {
      input,
      control: 'request'
    })
  })

  it.each([
    { recipeId: 'support_triage', state: { message: '' } },
    { recipeId: 'support_triage', state: { message: 'x', extra: 'field' } },
    { recipeId: 'lead_fit', state: { lead: 'x'.repeat(6001), criteria: 'y' } },
    { recipeId: 'retrieval_review', state: { query: 'q'.repeat(6000), passage: 'p'.repeat(6000) } },
    { recipeId: 'arbitrary_prompt', state: { task: 'x' } }
  ])('rejects invalid input before contacting the runtime: %j', async (input) => {
    const command = request(input, [JEV_REQUEST_V2_RUNTIME_CAPABILITY])
    await expect(command.run()).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(command.call).not.toHaveBeenCalled()
  })
})
