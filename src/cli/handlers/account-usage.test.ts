import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HandlerContext } from '../dispatch'
import type { RuntimeClient } from '../runtime-client'
import { RuntimeClientError } from '../runtime/types'
import { parseArgs, validateCommandAndFlags } from '../args'
import { ACCOUNT_COMMAND_SPECS } from '../specs/account'
import { ACCOUNT_USAGE_HANDLERS } from './account-usage'

describe('account usage CLI handler', () => {
  const inputFile = join(tmpdir(), 'private selected account.json')
  const call = vi.fn()
  const response = {
    id: 'usage-request',
    ok: true,
    result: {
      provider: 'codex',
      status: 'ok',
      session: null,
      weekly: null,
      updatedAt: 1_788_000_000_000,
      error: null
    },
    _meta: { runtimeId: 'selected-host' }
  }

  function context(flags: Map<string, string | boolean>, json = true): HandlerContext {
    return {
      client: { call } as unknown as RuntimeClient,
      cwd: tmpdir(),
      flags,
      json
    }
  }

  beforeEach(() => {
    call.mockReset().mockResolvedValue(response)
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('parses the published command and forwards only the exact private file path', async () => {
    const parsed = parseArgs(
      ['account', 'usage', '--input-file', inputFile, '--json'],
      ACCOUNT_COMMAND_SPECS.map((spec) => spec.path)
    )
    validateCommandAndFlags(ACCOUNT_COMMAND_SPECS, parsed)

    await ACCOUNT_USAGE_HANDLERS['account usage'](context(parsed.flags))

    expect(call).toHaveBeenCalledExactlyOnceWith(
      'accounts.probeSelectedUsage',
      { inputFile },
      { timeoutMs: 22_000 }
    )
    expect(console.log).toHaveBeenCalledExactlyOnceWith(JSON.stringify(response, null, 2))
  })

  it.each(['environment', 'pairing-code'])(
    'rejects explicit --%s selection without calling a runtime',
    async (flag) => {
      await expect(
        ACCOUNT_USAGE_HANDLERS['account usage'](
          context(
            new Map([
              ['input-file', inputFile],
              [flag, 'remote-host']
            ])
          )
        )
      ).rejects.toMatchObject({
        code: 'invalid_argument',
        message: expect.stringContaining(`--${flag}`)
      })
      expect(call).not.toHaveBeenCalled()
    }
  )

  it.each([
    undefined,
    true,
    '',
    'relative.json',
    '/private/secret\0.json',
    `/${'a'.repeat(4_096)}`
  ])('rejects invalid private input paths %# before calling a runtime', async (input) => {
    const flags = new Map<string, string | boolean>()
    if (input !== undefined) {
      flags.set('input-file', input)
    }

    await expect(ACCOUNT_USAGE_HANDLERS['account usage'](context(flags))).rejects.toMatchObject({
      code: 'invalid_argument',
      message: '--input-file must name an absolute private JSON request file.'
    })
    expect(call).not.toHaveBeenCalled()
  })

  it('fails closed when an older runtime has no selected-account usage method', async () => {
    const unavailable = new RuntimeClientError('method_not_found', 'Unknown method')
    call.mockRejectedValue(unavailable)

    await expect(
      ACCOUNT_USAGE_HANDLERS['account usage'](context(new Map([['input-file', inputFile]])))
    ).rejects.toBe(unavailable)
    expect(console.log).not.toHaveBeenCalled()
  })

  it('prints only the sanitized usage body in human mode', async () => {
    await ACCOUNT_USAGE_HANDLERS['account usage'](
      context(new Map([['input-file', inputFile]]), false)
    )

    expect(console.log).toHaveBeenCalledExactlyOnceWith(JSON.stringify(response.result, null, 2))
  })
})
