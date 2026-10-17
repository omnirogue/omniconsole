import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { deriveRemoteRuntimeTerminalCreateHandle } from '../runtime/remote-runtime-terminal-create-identity'
import { createTransferTarget, fileTransferTarget } from './session-transfer-lifecycle'
import { transferSession } from './session-manage-transfer-fixtures'

vi.mock('./session-transfer-new-target', () => ({
  watchNewTransferTarget: () => ({ bind: vi.fn(), close: vi.fn() })
}))

function fixture() {
  const events: string[] = []
  let created: {
    handle: string
    ptyId: string
    paneKey: string
    worktreeId: string
    title: string
  } | null = null
  const createTerminal = vi.fn(
    async (
      selector: string,
      options: { preAllocatedHandle: string; tabId: string; leafId: string; title: string }
    ) => {
      events.push('spawn')
      created = {
        handle: options.preAllocatedHandle,
        ptyId: 'new-pty',
        paneKey: `${options.tabId}:${options.leafId}`,
        worktreeId: selector.slice(3),
        title: options.title
      }
      throw new Error('publication reply lost after spawn')
    }
  )
  const dedupeTerminalCreate = vi.fn(
    async (
      client: string,
      selector: string,
      operation: string,
      reconcile: boolean,
      run: (selector: string, handle: string) => Promise<unknown>
    ) => {
      if (reconcile && created) {
        events.push('reconcile')
        return created
      }
      return run(
        selector,
        deriveRemoteRuntimeTerminalCreateHandle(client, selector.slice(3), operation)
      )
    }
  )
  const runtime = {
    createTerminal,
    dedupeTerminalCreate,
    getTerminalPaneKey: () => created?.paneKey ?? null
  } as unknown as OrcaRuntimeService
  const journal = vi.fn(async () => {
    events.push('journal')
  })
  return { runtime, journal, events, createTerminal, dedupeTerminalCreate }
}

describe('transfer lifecycle uncertain effects', () => {
  it('journals before spawn and reconciles a lost reply without a second creation', async () => {
    const f = fixture()
    const result = await createTransferTarget(
      f.runtime,
      transferSession('source'),
      'new',
      f.journal
    )
    expect(f.events).toEqual(['journal', 'spawn', 'reconcile'])
    expect(f.createTerminal).toHaveBeenCalledTimes(1)
    expect(f.journal).toHaveBeenCalledWith(
      'session.create',
      expect.anything(),
      expect.objectContaining({
        operationId: expect.any(String),
        handle: result.target.entry.terminal,
        paneKey: result.target.entry.paneKey,
        state: 'pending'
      })
    )
    result.proof.close()
  })
  it('blocks spawn if the intent journal cannot be saved', async () => {
    const f = fixture()
    f.journal.mockRejectedValueOnce(new Error('disk full'))
    await expect(
      createTransferTarget(f.runtime, transferSession('source'), 'new', f.journal)
    ).rejects.toThrow('disk full')
    expect(f.createTerminal).not.toHaveBeenCalled()
  })
  it('makes uncertain creation explicit with the reserved handle and operation identity', async () => {
    const f = fixture()
    f.dedupeTerminalCreate.mockRejectedValue(new Error('unreachable owner'))
    await expect(
      createTransferTarget(f.runtime, transferSession('source'), 'new', f.journal)
    ).rejects.toThrow(/may have created term_.*reconciled before retrying/)
    expect(f.dedupeTerminalCreate).toHaveBeenCalledTimes(2)
  })
  it('recovers filing from its durable receipt after reply loss without replaying the move', async () => {
    vi.useFakeTimers()
    try {
      const target = transferSession('target')
      const requestSessionFolders = vi
        .fn()
        .mockRejectedValueOnce(new Error('reply lost'))
        .mockResolvedValueOnce({ sessionKey: target.row.viewKey, folderId: null, at: Date.now() })
      const journal = vi.fn(async () => {})
      const source = transferSession('source')
      source.row.folderId = null
      source.row.saved = false
      const pending = fileTransferTarget({ requestSessionFolders }, target, source, journal)
      await vi.advanceTimersByTimeAsync(10_001)
      await pending
      expect(requestSessionFolders.mock.calls.map(([request]) => request.kind)).toEqual([
        'fileTransferredSession',
        'readTransferFileReceipt'
      ])
      expect(requestSessionFolders.mock.calls[0]?.[0].operationId).toBe(
        requestSessionFolders.mock.calls[1]?.[0].operationId
      )
      expect(journal).toHaveBeenCalledBefore(requestSessionFolders)
    } finally {
      vi.useRealTimers()
    }
  })
})
