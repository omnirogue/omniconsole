import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', async () => ({
  callRuntimeRpc: mocks.call,
  hasRuntimeRpcErrorCode: (await import('../../../../../shared/runtime-rpc-error-code'))
    .hasRuntimeRpcErrorCode
}))

import { listSessionWrittenFiles } from './session-artifact-client'

const TARGET = { kind: 'environment', environmentId: 'env-1' } as const
const SESSION = { provider: 'kimi', sessionId: 'session-1' }
const unknownMethod = (): Error =>
  Object.assign(new Error('Unknown method'), { code: 'method_not_found' })

afterEach(() => {
  mocks.call.mockReset()
})

describe('listSessionWrittenFiles', () => {
  it('reads one provider session from a host that knows the versioned method', async () => {
    mocks.call.mockResolvedValueOnce(['/w/a.md', 3])
    await expect(listSessionWrittenFiles(TARGET, SESSION)).resolves.toEqual(['/w/a.md'])
    expect(mocks.call).toHaveBeenCalledTimes(1)
    expect(mocks.call).toHaveBeenCalledWith(TARGET, 'artifacts.sessionWrittenFilesV2', SESSION)
  })

  it('takes only records naming this session from a first-release host', async () => {
    mocks.call.mockRejectedValueOnce(unknownMethod()).mockResolvedValueOnce([
      { paneKey: 'tab-1:1', sessionId: 'session-1', paths: ['/w/a.md'] },
      { paneKey: 'tab-2:1', sessionId: null, paths: ['/w/unattributed.md'] },
      { paneKey: 'tab-3:1', sessionId: 'session-2', paths: ['/w/other.md'] },
      { paneKey: 'tab-4:1', sessionId: 'session-1', paths: ['/w/c.md', '/w/a.md'] }
    ])
    await expect(listSessionWrittenFiles(TARGET, SESSION)).resolves.toEqual(['/w/c.md', '/w/a.md'])
    expect(mocks.call).toHaveBeenLastCalledWith(TARGET, 'artifacts.sessionWrittenFiles', undefined)
  })

  it('is empty, without guessing from old records, when the read itself fails', async () => {
    mocks.call.mockRejectedValueOnce(new Error('connection lost'))
    await expect(listSessionWrittenFiles(TARGET, SESSION)).resolves.toEqual([])
    expect(mocks.call).toHaveBeenCalledTimes(1)
  })

  it('is empty against a host from before written files were recorded', async () => {
    mocks.call.mockRejectedValue(unknownMethod())
    await expect(listSessionWrittenFiles(TARGET, SESSION)).resolves.toEqual([])
  })
})
