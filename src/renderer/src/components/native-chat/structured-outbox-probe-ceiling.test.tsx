// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'

const mocks = vi.hoisted(() => ({ call: vi.fn(), context: vi.fn() }))
vi.mock('@/lib/console-workflow-client', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  consoleWorkflowApi: () => ({ sessionTaskContext: mocks.context })
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

import {
  STRUCTURED_OUTBOX_PROBE_ATTEMPT_CEILING,
  STRUCTURED_OUTBOX_UNCONFIRMED_DECISION_MESSAGE
} from '../../../../shared/structured-agent-session-outbox-probe'
import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'
import { useSessionTasks } from '@/store/session-task-store'

const LOCAL_TARGET = { kind: 'local' } as const
const NO_SUBMISSIONS = [] as readonly AgentJournalSubmission[]

function unknownResultFor(clientMessageId: string) {
  return {
    ok: true,
    replayed: false,
    fence: 1,
    cursor: { epoch: 'epoch-1', sequence: 10 },
    value: {
      clientMessageId,
      submission: {
        clientMessageId,
        fence: 1,
        payloadFingerprint: 'fingerprint',
        dispatchState: 'unknown' as const,
        providerItemId: null,
        reason: 'socket closed',
        submittedAt: 10,
        resolvedAt: 10
      }
    }
  }
}

/**
 * Let queued probes fire and their responses settle. One cycle per call to
 * advanceTimers: the entry has to pass back through `queued` for the next probe
 * to be armed, so a single bulk advance would collapse those transitions.
 */
async function drainProbes(cycles: number): Promise<void> {
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000)
    })
  }
}

describe('unconfirmed outbox probes end in a decision', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.call.mockReset()
    mocks.call.mockImplementation(async (_target, _method, params) =>
      unknownResultFor(
        (params as { envelope: { clientOperationId: string } }).envelope.clientOperationId
      )
    )
    localStorage.clear()
    useSessionTasks.setState({ links: {}, loaded: true })
    mocks.context.mockReset().mockResolvedValue({ ok: false })
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '11111111-1111-4111-8111-111111111111'
    )
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    cleanup()
  })

  it('stops probing at the ceiling and hands the delivery to the person', async () => {
    const { result } = renderHook(() =>
      useStructuredAgentSessionOutbox({
        sessionId: 'session-probe-1',
        target: LOCAL_TARGET,
        fence: 1,
        submissions: NO_SUBMISSIONS
      })
    )
    await act(async () => {
      expect(result.current.send('never confirmed')).toBe(true)
    })
    await drainProbes(1)
    expect(result.current.outbox[0]?.state).toBe('unconfirmed')
    const clientMessageId = result.current.outbox[0]!.clientMessageId

    // Every probe window fits in one 20s cycle (exponential to a 16s cap).
    await drainProbes(STRUCTURED_OUTBOX_PROBE_ATTEMPT_CEILING + 2)
    const attempts = mocks.call.mock.calls.length
    expect(attempts).toBe(STRUCTURED_OUTBOX_PROBE_ATTEMPT_CEILING + 1)
    expect(result.current.unconfirmedNeedsDecisionId).toBe(clientMessageId)
    expect(result.current.error).toBe(STRUCTURED_OUTBOX_UNCONFIRMED_DECISION_MESSAGE)
    expect(result.current.outbox[0]?.state).toBe('unconfirmed')

    // And it stays stopped rather than resuming on the next tick.
    await drainProbes(4)
    expect(mocks.call.mock.calls.length).toBe(attempts)
  })

  it('re-arms the probe budget when the person retries', async () => {
    const { result } = renderHook(() =>
      useStructuredAgentSessionOutbox({
        sessionId: 'session-probe-2',
        target: LOCAL_TARGET,
        fence: 1,
        submissions: NO_SUBMISSIONS
      })
    )
    await act(async () => {
      expect(result.current.send('never confirmed')).toBe(true)
    })
    await drainProbes(STRUCTURED_OUTBOX_PROBE_ATTEMPT_CEILING + 2)
    const spent = mocks.call.mock.calls.length
    const clientMessageId = result.current.outbox[0]!.clientMessageId

    await act(async () => {
      result.current.retry(clientMessageId)
    })
    await drainProbes(3)
    expect(mocks.call.mock.calls.length).toBeGreaterThan(spent)
    expect(result.current.unconfirmedNeedsDecisionId).toBeNull()
  })
})
