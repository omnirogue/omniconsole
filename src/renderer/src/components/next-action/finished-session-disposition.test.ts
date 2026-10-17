/**
 * A close or save that ran out of retries is a footnote to a COMPLETED run
 * (`docs/reference/session-run-lifecycle.md`): it is read only from a sealed host record, and
 * "Try again" is the host's own retry followed by the registry publish that carries it out.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { conversationPlanFixture } from '@/lib/conversation-plan-fixture'
import type { SessionChain } from '../../../../shared/session-chain-types'
import type { SessionRunDisposition } from '../../../../shared/session-run-completion'

const mocks = vi.hoisted(() => ({
  retrySessionDisposition: vi.fn(),
  getSessionChain: vi.fn(),
  setSessionChainEntry: vi.fn(),
  publishSessionChains: vi.fn()
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/components/next-step/next-step-outcome-client', () => ({
  retrySessionDisposition: mocks.retrySessionDisposition
}))
vi.mock('@/lib/session-chain-registry', () => ({
  getSessionChain: mocks.getSessionChain,
  setSessionChainEntry: mocks.setSessionChainEntry,
  publishSessionChains: mocks.publishSessionChains
}))

import {
  failedDispositionLabel,
  failedSessionDisposition,
  retryFinishedSessionDisposition
} from './finished-session-disposition'

const NOW = 1_700_000_000_000

function finished(disposition?: Partial<SessionRunDisposition>, sealed = true): SessionChain {
  const chain = conversationPlanFixture()
  chain.state = 'done'
  if (sealed) {
    chain.outcomeSet!.completion = {
      at: NOW,
      outcomes: [{ id: 'outcome', revision: 1 }],
      evidenceIds: []
    }
  }
  if (disposition) {
    chain.outcomeSet!.disposition = {
      intent: 'close',
      state: 'failed',
      operationId: 'op_1',
      attempts: 5,
      updatedAt: NOW,
      ...disposition
    }
  }
  return chain
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset()
  }
})

describe('a close or save the host gave up on', () => {
  it('is read from a sealed record whose disposition failed, with its reason as a diagnostic', () => {
    expect(
      failedSessionDisposition(
        finished({ lastError: 'The session is pinned or declined to close.' })
      )
    ).toEqual({ intent: 'close', error: 'The session is pinned or declined to close.' })
    expect(failedSessionDisposition(finished({ intent: 'save', folderId: 'folder_1' }))).toEqual({
      intent: 'save'
    })
  })

  it('is nothing while the host still retries, once it happened, or when nothing was asked', () => {
    expect(failedSessionDisposition(null)).toBeNull()
    expect(failedSessionDisposition(finished())).toBeNull()
    expect(failedSessionDisposition(finished({ state: 'pending', attempts: 2 }))).toBeNull()
    expect(failedSessionDisposition(finished({ state: 'applied', appliedAt: NOW }))).toBeNull()
    expect(failedSessionDisposition(finished({ intent: 'completed' }))).toBeNull()
    // Why: without the seal there is no finished run for a disposition to belong to.
    expect(failedSessionDisposition(finished({}, false))).toBeNull()
  })

  it('never words it as a failure of the work or as something the run needs', () => {
    for (const label of [failedDispositionLabel('close'), failedDispositionLabel('save')]) {
      expect(label).not.toMatch(/needs you|failed/i)
    }
    expect(failedDispositionLabel('close')).toBe('Could not close this session')
    expect(failedDispositionLabel('save')).toBe('Could not save this session')
  })
})

describe('Try again', () => {
  it('asks the owning host, stores its answer and publishes it so the window acts on it', async () => {
    const chain = finished({})
    const retried = finished({ state: 'pending', attempts: 0 })
    mocks.retrySessionDisposition.mockResolvedValue(retried)
    await retryFinishedSessionDisposition(chain)
    expect(mocks.retrySessionDisposition).toHaveBeenCalledExactlyOnceWith(chain)
    expect(mocks.setSessionChainEntry).toHaveBeenCalledExactlyOnceWith(retried)
    expect(mocks.publishSessionChains).toHaveBeenCalledTimes(1)
    expect(mocks.getSessionChain).not.toHaveBeenCalled()
  })

  it('finds the run by id for a surface that holds only the id', async () => {
    const chain = finished({})
    mocks.getSessionChain.mockReturnValue(chain)
    mocks.retrySessionDisposition.mockResolvedValue(chain)
    await retryFinishedSessionDisposition(chain.id)
    expect(mocks.getSessionChain).toHaveBeenCalledWith(chain.id)
    expect(mocks.retrySessionDisposition).toHaveBeenCalledExactlyOnceWith(chain)
  })

  it('says so, and asks the host nothing, when this device has not loaded the run', async () => {
    mocks.getSessionChain.mockReturnValue(null)
    await expect(retryFinishedSessionDisposition('source_unknown')).rejects.toThrow(
      'This run is not loaded on this device yet. Try again in a moment.'
    )
    expect(mocks.retrySessionDisposition).not.toHaveBeenCalled()
    expect(mocks.publishSessionChains).not.toHaveBeenCalled()
  })

  it('publishes nothing when the host refuses, and lets the refusal reach the surface', async () => {
    mocks.retrySessionDisposition.mockRejectedValue(new Error('The host is unreachable.'))
    await expect(retryFinishedSessionDisposition(finished({}))).rejects.toThrow(
      'The host is unreachable.'
    )
    expect(mocks.setSessionChainEntry).not.toHaveBeenCalled()
    expect(mocks.publishSessionChains).not.toHaveBeenCalled()
  })
})
