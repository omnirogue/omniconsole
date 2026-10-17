import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as CanonicalWorkerRecord from '../../orchestration/canonical-worker-record'
import type { OrcaRuntimeService } from '../../omni-runtime'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { isStreamingMethod } from '../core'

const { probe, readPrivateFile } = vi.hoisted(() => ({
  probe: vi.fn(),
  readPrivateFile: vi.fn()
}))
vi.mock('../../../rate-limits/selected-account-usage', () => ({
  probeSelectedAccountUsage: probe
}))
vi.mock('../../orchestration/canonical-worker-record', async (importOriginal) => {
  const actual = await importOriginal<typeof CanonicalWorkerRecord>()
  readPrivateFile.mockImplementation(actual.consumeCanonicalWorkerFile)
  return { ...actual, consumeCanonicalWorkerFile: readPrivateFile }
})

import { SELECTED_ACCOUNT_USAGE_METHODS } from './selected-account-usage'

const method = SELECTED_ACCOUNT_USAGE_METHODS.find(
  (candidate) => candidate.name === 'accounts.probeSelectedUsage'
)!
const runtime = {} as OrcaRuntimeService
const privateInputError = 'Selected account usage input must be a valid private request file.'

async function invoke(inputFile: string, clientKind?: 'mobile' | 'runtime') {
  if (isStreamingMethod(method)) {
    throw new Error('Selected usage must be a request method')
  }
  return method.handler(method.params?.parse({ inputFile }), { runtime, clientKind })
}

function successfulUsage(): ProviderRateLimits {
  return {
    provider: 'codex',
    status: 'ok',
    updatedAt: Date.now() - 30_000,
    error: null,
    session: {
      usedPercent: 17,
      windowMinutes: 300,
      resetsAt: null,
      resetDescription: null
    },
    weekly: null
  }
}

describe('selected account usage RPC boundary', () => {
  beforeEach(() => {
    probe.mockReset().mockResolvedValue(successfulUsage())
    readPrivateFile.mockClear()
  })

  it.each(['mobile', 'runtime'] as const)(
    'rejects %s callers before touching the private file or provider',
    async (clientKind) => {
      await expect(invoke(join(tmpdir(), 'not-readable-secret.json'), clientKind)).rejects.toThrow(
        'Selected account usage is only available on the local host runtime.'
      )
      expect(readPrivateFile).not.toHaveBeenCalled()
      expect(probe).not.toHaveBeenCalled()
    }
  )

  it('accepts only the input path in RPC parameters', () => {
    for (const params of [
      {},
      { inputFile: true },
      { inputFile: '' },
      { inputFile: 'a'.repeat(4_097) },
      { inputFile: '/private/request.json', token: 'never-on-the-wire' },
      { inputFile: '/private/request.json', clientKind: undefined }
    ]) {
      expect(method.params?.safeParse(params).success).toBe(false)
    }
    expect(readPrivateFile).not.toHaveBeenCalled()
  })
})

describe.skipIf(typeof process.getuid !== 'function')('selected usage private input files', () => {
  let directory: string
  let inputFile: string

  function writeRequest(request: unknown) {
    writeFileSync(inputFile, JSON.stringify(request), { mode: 0o600 })
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'selected-account-usage-rpc-'))
    inputFile = join(directory, 'request.json')
    probe.mockReset().mockResolvedValue(successfulUsage())
    readPrivateFile.mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(directory, { recursive: true, force: true })
  })

  it('reads an exact selected account and leaves private-file cleanup to the caller', async () => {
    const request = { version: 1, provider: 'codex', configRoot: directory }
    const usage = successfulUsage()
    probe.mockResolvedValue(usage)
    writeRequest(request)

    await expect(invoke(inputFile)).resolves.toEqual(usage)

    expect(readPrivateFile).toHaveBeenCalledWith(inputFile, false)
    expect(probe).toHaveBeenCalledExactlyOnceWith(request)
    expect(existsSync(inputFile)).toBe(true)
  })

  it('returns only sanitized usage and preserves the provider observation time', async () => {
    writeRequest({ version: 1, provider: 'codex', configRoot: directory })
    const usage = successfulUsage()
    probe.mockResolvedValue({
      ...usage,
      planType: 'secret-plan',
      session: { ...usage.session, resetDescription: 'secret-description' },
      usageMetadata: {
        source: 'oauth',
        credentialSource: 'secret-path',
        authProvenance: 'secret@example.com'
      }
    })

    const result = await invoke(inputFile)

    expect(result).toMatchObject({
      status: 'ok',
      error: null,
      updatedAt: usage.updatedAt,
      session: { resetDescription: null },
      usageMetadata: { source: 'oauth' }
    })
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(JSON.stringify(result)).not.toContain(directory)
  })

  it.each([
    { version: 2, provider: 'codex', configRoot: '/selected' },
    { version: 1, provider: 'codex', configRoot: 'relative' },
    { version: 1, provider: 'codex' },
    { version: 1, provider: 'codex', configRoot: '/selected', token: 'secret-token' },
    { version: 1, provider: 'unrecognized', token: 'secret-token' }
  ])('rejects malformed private request %# without leaking its content', async (request) => {
    writeRequest(request)

    await expect(invoke(inputFile)).rejects.toThrow(privateInputError)
    expect(probe).not.toHaveBeenCalled()
  })

  it('rejects malformed JSON without exposing parser excerpts', async () => {
    writeFileSync(inputFile, '{"token":"secret-token",', { mode: 0o600 })

    await expect(invoke(inputFile)).rejects.toThrow(privateInputError)
    expect(probe).not.toHaveBeenCalled()
  })

  it('rejects files readable by other users', async () => {
    writeRequest({ version: 1, provider: 'codex', configRoot: directory })
    chmodSync(inputFile, 0o644)

    await expect(invoke(inputFile)).rejects.toThrow(privateInputError)
    expect(probe).not.toHaveBeenCalled()
  })

  it('rejects files owned by another runtime user', async () => {
    writeRequest({ version: 1, provider: 'codex', configRoot: directory })
    vi.spyOn(process, 'getuid').mockReturnValue(process.getuid!() + 1)

    await expect(invoke(inputFile)).rejects.toThrow(privateInputError)
    expect(probe).not.toHaveBeenCalled()
  })

  it('rejects symlinks without reading the destination', async () => {
    writeRequest({ version: 1, provider: 'codex', configRoot: directory })
    const link = join(directory, 'linked.json')
    symlinkSync(inputFile, link)

    await expect(invoke(link)).rejects.toThrow(privateInputError)
    expect(probe).not.toHaveBeenCalled()
  })

  it('rejects non-files and non-absolute paths', async () => {
    await expect(invoke(directory)).rejects.toThrow(privateInputError)
    await expect(invoke('relative-private-input.json')).rejects.toThrow(privateInputError)
    expect(probe).not.toHaveBeenCalled()
  })

  it('does not publish unexpected provider exception details', async () => {
    writeRequest({ version: 1, provider: 'codex', configRoot: directory })
    probe.mockRejectedValue(new Error('secret-provider-token and /private/account'))

    await expect(invoke(inputFile)).rejects.toThrow('Selected account usage probe failed.')
  })
})
