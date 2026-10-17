import { describe, expect, it, vi } from 'vitest'
import type { SessionChain } from '../../../../shared/session-chain-types'
import type { SessionOutcomeSet } from '../../../../shared/session-outcome-types'
import {
  SESSION_DISPOSITION_MAX_ATTEMPTS,
  recordSessionRunDisposition,
  sealSessionRunCompletion
} from '../../../../shared/session-run-completion'
import {
  blockRunOutcome,
  proveRun,
  runSet
} from '../../../../shared/session-run-lifecycle.test-fixture'
import type { OrcaRuntimeService } from '../../omni-runtime'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { SESSION_CHAIN_METHODS } from './session-chains'

const NOW = 7_000_000
const STALL = 'No activity was observed for 180s, so the agent was treated as stalled.'
const USER = { clientId: 'desktop-renderer' }

const request = (method: string, params?: unknown): RpcRequest => ({
  id: 'req-1',
  authToken: 'tok',
  method,
  params
})

const chain = (
  id: string,
  outcomeSet: SessionOutcomeSet,
  state: SessionChain['state']
): SessionChain => ({
  id,
  workspacePath: '/w',
  worktreeId: 'folder:f1',
  hostId: 'local',
  sourcePaneKey: `tab-${id}:leaf`,
  sourceRowKey: `row-${id}`,
  auto: true,
  steps: [],
  currentIndex: 0,
  state,
  outcomeSet,
  createdAt: 1,
  updatedAt: 2
})

const proven = (): SessionOutcomeSet => proveRun(runSet(), 'one')
const sealed = (finish?: SessionOutcomeSet['sessionFinish']): SessionOutcomeSet =>
  sealSessionRunCompletion(
    { ...proven(), ...(finish ? { sessionFinish: finish } : {}) },
    { now: NOW, operationId: 'op_seal' }
  )

function host(chains: SessionChain[] = []) {
  const service = {
    now: () => NOW,
    reportDisposition: vi.fn(async (id: string) => chains.find((entry) => entry.id === id)!),
    retryDisposition: vi.fn(async (id: string) => chains.find((entry) => entry.id === id)!),
    reconcile: vi.fn(async () => {})
  }
  const runtime = {
    getRuntimeId: () => 'runtime',
    listSessionChains: () => chains,
    getSessionOutcomeService: () => service
  } as unknown as OrcaRuntimeService
  return { service, dispatcher: new RpcDispatcher({ runtime, methods: SESSION_CHAIN_METHODS }) }
}

describe('sessionChain.reportDisposition', () => {
  it('hands the window’s report to the host under the operation it names', async () => {
    const run = chain('chn_1', sealed({ action: 'end' }), 'done')
    const { service, dispatcher } = host([run])
    await expect(
      dispatcher.dispatch(
        request('sessionChain.reportDisposition', {
          chainId: 'chn_1',
          expectedExecutionRuntimeId: 'runtime',
          operationId: 'op_seal',
          ok: false,
          error: 'The session is pinned or declined to close.'
        }),
        USER
      )
    ).resolves.toMatchObject({ ok: true, result: { chain: { id: 'chn_1' } } })
    expect(service.reportDisposition).toHaveBeenCalledWith('chn_1', {
      operationId: 'op_seal',
      ok: false,
      error: 'The session is pinned or declined to close.'
    })
  })

  it('is fenced: another runtime, an agent caller and a malformed report are all refused', async () => {
    const { service, dispatcher } = host([chain('chn_1', sealed({ action: 'end' }), 'done')])
    const report = { chainId: 'chn_1', operationId: 'op_seal', ok: true }
    await expect(
      dispatcher.dispatch(
        request('sessionChain.reportDisposition', {
          ...report,
          expectedExecutionRuntimeId: 'another-runtime'
        }),
        USER
      )
    ).resolves.toMatchObject({ ok: false })
    // Closing a tab is a window fact: an agent's CLI cannot assert that it happened.
    await expect(
      dispatcher.dispatch(request('sessionChain.reportDisposition', report))
    ).resolves.toMatchObject({ ok: false })
    await expect(
      dispatcher.dispatch(
        request('sessionChain.reportDisposition', { ...report, operationId: 'not an id' }),
        USER
      )
    ).resolves.toMatchObject({ ok: false })
    await expect(
      dispatcher.dispatch(
        request('sessionChain.reportDisposition', { ...report, reopen: true }),
        USER
      )
    ).resolves.toMatchObject({ ok: false })
    expect(service.reportDisposition).not.toHaveBeenCalled()
  })
})

it('sessionChain.retryDisposition is the person’s own request', async () => {
  const { service, dispatcher } = host([chain('chn_1', sealed({ action: 'end' }), 'done')])
  await expect(
    dispatcher.dispatch(request('sessionChain.retryDisposition', { chainId: 'chn_1' }))
  ).resolves.toMatchObject({ ok: false })
  await expect(
    dispatcher.dispatch(request('sessionChain.retryDisposition', { chainId: 'chn_1' }), USER)
  ).resolves.toMatchObject({ ok: true, result: { chain: { id: 'chn_1' } } })
  expect(service.retryDisposition).toHaveBeenCalledTimes(1)
  expect(service.retryDisposition).toHaveBeenCalledWith('chn_1')
})

it('sessionChain.reconcile asks the host to converge now, as a refresh', async () => {
  const { service, dispatcher } = host()
  await expect(
    dispatcher.dispatch(
      request('sessionChain.reconcile', { expectedExecutionRuntimeId: 'another-runtime' })
    )
  ).resolves.toMatchObject({ ok: false })
  expect(service.reconcile).not.toHaveBeenCalled()
  await expect(
    dispatcher.dispatch(
      request('sessionChain.reconcile', { expectedExecutionRuntimeId: 'runtime' })
    )
  ).resolves.toMatchObject({ ok: true, result: { reconciled: true } })
  expect(service.reconcile).toHaveBeenCalledWith('refresh')
})

describe('sessionChain.auditRuns', () => {
  it('lists every seeded contradiction, and nothing for healthy runs', async () => {
    let exhausted = sealed({ action: 'end' })
    for (let attempt = 0; attempt < SESSION_DISPOSITION_MAX_ATTEMPTS; attempt++) {
      exhausted = recordSessionRunDisposition(
        exhausted,
        { operationId: 'op_seal', ok: false, error: 'Pinned.' },
        NOW + attempt
      )
    }
    const failed = blockRunOutcome(runSet(), 'one', STALL, {
      class: 'failed',
      code: 'worker-stalled',
      since: NOW
    })
    const chains = [
      chain('healthy-sealed', sealed(), 'done'),
      chain('healthy-running', runSet(), 'waiting'),
      chain('healthy-failed', failed, 'failed'),
      chain('cancelled', proven(), 'cancelled'),
      chain('stranded', proven(), 'waiting'),
      chain('unsealed', proven(), 'done'),
      chain('legacy-needs-you', blockRunOutcome(runSet(), 'one', STALL), 'waiting'),
      chain('failed-as-waiting', failed, 'waiting'),
      chain('close-gave-up', exhausted, 'done')
    ]
    const { dispatcher } = host(chains)
    const response = await dispatcher.dispatch(
      request('sessionChain.auditRuns', { expectedExecutionRuntimeId: 'runtime' })
    )
    expect(response).toMatchObject({ ok: true })
    const rows = (response as { result: { rows: { chainId: string }[] } }).result.rows
    expect(rows.map((row) => row.chainId)).toEqual([
      'stranded',
      'unsealed',
      'legacy-needs-you',
      'failed-as-waiting',
      'close-gave-up'
    ])
    expect(rows).toMatchObject([
      {
        chainId: 'stranded',
        state: 'waiting',
        phase: 'completed',
        findings: ['complete-not-recorded', 'complete-not-sealed'],
        repair: 'record-completion'
      },
      { chainId: 'unsealed', findings: ['complete-not-sealed'], repair: 'seal' },
      {
        chainId: 'legacy-needs-you',
        phase: 'failed',
        findings: ['unclassified-block', 'state-disagrees-with-phase'],
        repair: 'classify',
        reasons: [`one: ${STALL}`]
      },
      {
        chainId: 'failed-as-waiting',
        findings: ['state-disagrees-with-phase'],
        repair: 'rewrite-state'
      },
      { chainId: 'close-gave-up', phase: 'completed', findings: ['disposition-failed'] }
    ])
  })

  it('is read-only and fenced to this runtime', async () => {
    const stranded = chain('stranded', proven(), 'waiting')
    const before = JSON.stringify(stranded)
    const { service, dispatcher } = host([stranded])
    await expect(
      dispatcher.dispatch(
        request('sessionChain.auditRuns', { expectedExecutionRuntimeId: 'another-runtime' })
      )
    ).resolves.toMatchObject({ ok: false })
    await dispatcher.dispatch(
      request('sessionChain.auditRuns', { expectedExecutionRuntimeId: 'runtime' })
    )
    expect(JSON.stringify(stranded)).toBe(before)
    expect(service.reconcile).not.toHaveBeenCalled()
    expect(service.reportDisposition).not.toHaveBeenCalled()
  })
})
