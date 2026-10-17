import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { archiveTransferredSources, transferArchiveTarget } from './session-transfer-archive'
import { transferSession } from './session-manage-transfer-fixtures'

describe('transfer archive receipt reconciliation', () => {
  const sources = [transferSession('first'), transferSession('second')]
  const target = transferSession('target')
  const targets = sources.map(transferArchiveTarget)
  const archive = (requestSessionFolders: OrcaRuntimeService['requestSessionFolders']) =>
    archiveTransferredSources({ requestSessionFolders }, sources, 'handed off', () => true, target)

  it('accepts the exact operation receipt without replaying the archive', async () => {
    const request = vi.fn<OrcaRuntimeService['requestSessionFolders']>(async (r) =>
      r.kind === 'archiveSessions' ? { archived: targets, operationId: r.operationId } : null
    )
    expect(await archive(request)).toEqual({ status: 'archived' })
    expect(request).toHaveBeenCalledOnce()
  })

  it('reconciles a lost reply from the persisted same-operation receipt only', async () => {
    const request = vi
      .fn<OrcaRuntimeService['requestSessionFolders']>()
      .mockRejectedValueOnce(new Error('reply lost'))
      .mockResolvedValueOnce(sources.map((source) => source.row.viewKey))
    expect(await archive(request)).toEqual({ status: 'archived' })
    expect(request).toHaveBeenCalledTimes(2)
    const first = request.mock.calls[0][0]
    expect(request).toHaveBeenLastCalledWith({
      kind: 'readTransferArchiveReceipt',
      operationId: 'operationId' in first ? first.operationId : null
    })
  })

  it.each([null, ['first'], ['replacement']])(
    'does not infer success from absent or different receipts: %j',
    async (receipt) => {
      const request = vi
        .fn<OrcaRuntimeService['requestSessionFolders']>()
        .mockRejectedValueOnce(new Error('reply lost'))
        .mockResolvedValueOnce(receipt)
      expect(await archive(request)).toMatchObject({ status: 'unknown' })
      expect(request).toHaveBeenCalledTimes(2)
    }
  )

  it('preserves uncertainty when the renderer and persistent state are unavailable', async () => {
    const request = vi.fn(async () => {
      throw new Error('window unavailable')
    })
    expect(await archive(request)).toMatchObject({ status: 'unknown' })
    expect(request).toHaveBeenCalledTimes(2)
  })
})
