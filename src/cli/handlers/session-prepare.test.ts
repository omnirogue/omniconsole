import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../args'
import type { RuntimeClient } from '../runtime-client'
import { COMMAND_SPECS } from '../specs'
import { readTextInputFile } from '../text-input-file'
import { SESSION_PREPARE_HANDLERS } from './session-prepare'

vi.mock('../text-input-file', () => ({ readTextInputFile: vi.fn() }))
afterEach(() => vi.restoreAllMocks())

function fixture(text: string) {
  vi.mocked(readTextInputFile).mockResolvedValue(text)
  const output = vi.spyOn(console, 'log').mockImplementation(() => {})
  const call = vi.fn(async (_method: string, _request: unknown, _options: unknown) => ({
    result: { batch: { id: 'batch-1', state: 'running' } }
  }))
  const context = {
    flags: parseArgs(['session', 'prepare', '--connector-file', 'request.json']).flags,
    client: { call, isRemote: false } as unknown as RuntimeClient,
    cwd: '/executor',
    json: true
  }
  return { call, output, context, run: () => SESSION_PREPARE_HANDLERS['session prepare']!(context) }
}

describe('session prepare connector transport', () => {
  it('forwards the exact request envelope and returns the batch for durable polling', async () => {
    const request = {
      connector: { payload: 'signed-payload', signature: 'signed-proof' },
      request: '  Fix "login".\nKeep this line.  '
    }
    const f = fixture(JSON.stringify(request))
    await f.run()
    expect(f.call).toHaveBeenCalledExactlyOnceWith('sessionPrep.request', request, {
      timeoutMs: 45_000
    })
    expect(readTextInputFile).toHaveBeenCalledWith('request.json', '/executor', {
      label: 'signed connector request',
      maxBytes: 256 * 1024
    })
    expect(JSON.parse(String(f.output.mock.calls[0]?.[0]))).toEqual({
      result: { batch: { id: 'batch-1', state: 'running' } }
    })
  })

  it.each(['bad json', '[]', 'null', '"request"'])(
    'rejects malformed envelope %s before RPC',
    async (text) => {
      const f = fixture(text)
      await expect(f.run()).rejects.toThrow('must hold one JSON object')
      expect(f.call).not.toHaveBeenCalled()
    }
  )

  it.each(['permission denied', 'request timed out'])(
    'never falls back to launch after %s',
    async (error) => {
      const f = fixture('{}')
      f.call.mockRejectedValue(new Error(error))
      await expect(f.run()).rejects.toThrow(error)
      expect(f.call).toHaveBeenCalledTimes(1)
      expect(f.call.mock.calls[0]?.[0]).toBe('sessionPrep.request')
    }
  )

  it('registers only the signed file transport, with no local user override', () => {
    const spec = COMMAND_SPECS.find((entry) => entry.path.join(' ') === 'session prepare')
    expect(spec?.allowedFlags).toContain('connector-file')
    expect(spec?.allowedFlags).not.toContain('user')
    expect(spec?.allowedFlags).not.toContain('raw')
  })
})
