import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SessionChain } from '../../../shared/session-chain-types'
import type { SessionFollowUpDraft } from './session-follow-up-commands'

const mocks = vi.hoisted(() => ({ upsert: vi.fn(), remove: vi.fn(), run: vi.fn() }))
vi.mock('@/lib/session-chain-client', () => ({
  upsertSessionChainOnHost: mocks.upsert,
  removeSessionChainOnHost: mocks.remove
}))
vi.mock('@/lib/session-chain-support', () => ({
  LOCAL_CHAIN_TARGET: { kind: 'local' },
  randomChainId: (prefix: string) =>
    `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
}))
vi.mock('@/lib/session-chain-runner', async () => {
  const registry = await import('@/lib/session-chain-registry')
  return {
    runSessionChainNow: mocks.run,
    stopSessionChainRun: (id: string) => {
      const entry = registry.getSessionChainEntry(id)
      entry?.controller?.abort()
      if (entry) {
        entry.controller = null
      }
    }
  }
})
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ getKnownWorktreeById: () => ({ path: '/workspace' }) }) }
}))
vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string) => fallback
}))
import {
  getSessionChainEntry,
  clearSessionChainEntries,
  publishSessionChains
} from './session-chain-registry'
import {
  cancelSessionFollowUp,
  dismissSessionFollowUp,
  saveSessionFollowUp
} from './session-follow-up-commands'

const source = {
  rowKey: 'source-row',
  worktreeId: 'folder:workspace',
  hostId: 'local' as const,
  paneKey: 'source:pane',
  label: 'Source'
}
const draft: SessionFollowUpDraft = {
  taskId: null,
  taskTitle: 'Deliver result',
  recipients: [{ employeeId: 'emp_recipient', name: 'Recipient' }],
  deliverables: { kind: 'files', paths: ['/workspace/result.txt'] },
  includeSummary: false,
  note: 'Saved request'
}

beforeEach(() => {
  vi.resetAllMocks()
  clearSessionChainEntries()
  publishSessionChains()
  mocks.upsert.mockImplementation(async (_target: unknown, chain: SessionChain) => chain)
  mocks.remove.mockResolvedValue(undefined)
})
afterEach(() => clearSessionChainEntries())

it.each([
  ['new save', 'success'],
  ['new save', 'failure'],
  ['edit', 'success'],
  ['edit', 'failure']
] as const)(
  'preserves cancellation while a pending %s finishes with %s',
  async (operation, result) => {
    if (operation === 'edit') {
      await saveSessionFollowUp(source, draft)
    }
    mocks.run.mockClear()
    let resolveSave!: () => void
    let rejectSave!: (error: Error) => void
    let pendingChain!: SessionChain
    mocks.upsert.mockImplementationOnce((_target: unknown, chain: SessionChain) => {
      pendingChain = chain
      return new Promise<SessionChain>((resolve, reject) => {
        resolveSave = () => resolve(chain)
        rejectSave = reject
      })
    })
    const saving = saveSessionFollowUp(source, { ...draft, note: 'Pending save' })
    // Observe a rejection immediately, while leaving the caller's original error intact.
    const settled = saving.then(
      (chain) => ({ chain }),
      (error: unknown) => ({ error })
    )
    await vi.waitFor(() => expect(pendingChain).toBeDefined())
    await cancelSessionFollowUp(pendingChain.id)
    const cancelled = getSessionChainEntry(pendingChain.id)!.chain
    expect(cancelled.state).toBe('cancelled')
    const failure = new Error('Original persistence failure')
    if (result === 'success') {
      resolveSave()
      expect(await settled).toEqual({ chain: pendingChain })
    } else {
      rejectSave(failure)
      expect(await settled).toEqual({ error: failure })
    }
    expect(getSessionChainEntry(pendingChain.id)!.chain).toBe(cancelled)
    expect(mocks.run).not.toHaveBeenCalled()
    expect(mocks.upsert.mock.calls.at(-1)?.[1]).toBe(cancelled)
  }
)

it.each(['success', 'failure'] as const)(
  'does not restore a dismissed chain after an edit %s',
  async (result) => {
    const original = await saveSessionFollowUp(source, draft)
    mocks.run.mockClear()
    let resolveSave!: () => void
    let rejectSave!: (error: Error) => void
    mocks.upsert.mockImplementationOnce(
      (_target: unknown, chain: SessionChain) =>
        new Promise<SessionChain>((resolve, reject) => {
          resolveSave = () => resolve(chain)
          rejectSave = reject
        })
    )
    const saving = saveSessionFollowUp(source, { ...draft, note: 'Pending edit' })
    const settled = saving.catch((error: unknown) => error)
    await vi.waitFor(() => expect(resolveSave).toBeDefined())
    await dismissSessionFollowUp(original.id)
    if (result === 'success') {
      resolveSave()
    } else {
      rejectSave(new Error('Original persistence failure'))
    }
    await settled
    expect(getSessionChainEntry(original.id)).toBeNull()
    expect(mocks.run).not.toHaveBeenCalled()
  }
)
