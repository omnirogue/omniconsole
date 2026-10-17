import { afterEach, expect, it } from 'vitest'
import { ownReviewAttention, personReviewAttention } from '../../shared/session-attention-drafts'
import { openHumanAttention } from '../../shared/session-human-attention'
import type { RpcRequest } from './rpc/core'
import { RpcDispatcher } from './rpc/dispatcher'
import { SESSION_CHAIN_METHODS } from './rpc/methods/session-chains'
import {
  T0,
  completionHarness,
  type CompletionHarness
} from './session-outcome-completion-test-harness'

const harnesses: CompletionHarness[] = []
afterEach(async () => {
  for (const h of harnesses.splice(0).toReversed()) {
    await h.service.suspend()
    await h.dispose()
  }
})
function harness(restoreFrom?: string): CompletionHarness {
  const h = completionHarness(restoreFrom)
  harnesses.push(h)
  return h
}

const scope = { outcomeId: 'result', outcomeRevision: 1, conditionId: 'file' }

function progressRequest(h: CompletionHarness): RpcRequest {
  return {
    id: 'req-1',
    authToken: 'tok',
    method: 'sessionChain.outcomeProgress',
    params: { id: 'chain', expectedExecutionRuntimeId: h.runtime.getRuntimeId() }
  }
}

it('announces a request to the owner exactly once across re-saves, reads and a restart', async () => {
  const h = harness()
  await h.commit()
  const committed = h.service.get('chain')
  const mine = openHumanAttention(
    committed.outcomeSet!,
    ownReviewAttention({ scope, title: 'Result' }),
    T0 - 1_000
  )
  // Somebody else's review rides on the same run: it is what the run waits on, nobody's alarm here.
  const theirs = openHumanAttention(
    mine.set,
    personReviewAttention({ scope, title: 'Result', employeeId: 'emp_2', name: 'Eve' }),
    T0 - 1_000
  )
  const saved = h.service.save({ ...committed, outcomeSet: theirs.set }, 1)
  expect(h.announce).toHaveBeenCalledTimes(1)
  expect(h.announce.mock.calls[0]![0]).toMatchObject({ id: 'chain' })
  expect(h.announce.mock.calls[0]![1].map((request) => request.id)).toEqual([mine.id])
  const stamped = saved.outcomeSet!.attention!
  expect(stamped.find((entry) => entry.id === mine.id)).toMatchObject({
    state: 'open',
    notifiedAt: T0
  })
  expect(stamped.find((entry) => entry.id === theirs.id)!.notifiedAt).toBeUndefined()

  // Looking at the run is not answering it: a read neither resolves the request nor repeats it.
  const dispatcher = new RpcDispatcher({ runtime: h.runtime, methods: SESSION_CHAIN_METHODS })
  for (let read = 0; read < 2; read++) {
    await expect(dispatcher.dispatch(progressRequest(h))).resolves.toMatchObject({
      ok: true,
      result: {
        lifecycle: 'needs-you',
        phase: 'needs-you',
        attention: [{ id: mine.id, state: 'open', notifiedAt: T0 }]
      }
    })
  }
  expect(h.service.get('chain')).toEqual(saved)

  h.clock.now = T0 + 30_000
  h.service.save(h.service.get('chain'), 1)
  h.service.save({ ...h.service.get('chain'), outcomeSet: theirs.set }, 1)
  expect(h.announce).toHaveBeenCalledTimes(1)
  await h.stop()

  // A restart reads the durable stamp; the new process has nothing left to announce.
  const restarted = harness(h.workspace)
  restarted.clock.now = T0 + 60_000
  const reread = restarted.service.get('chain')
  expect(reread.outcomeSet!.attention!.find((entry) => entry.id === mine.id)).toMatchObject({
    state: 'open',
    notifiedAt: T0
  })
  restarted.service.save(reread, 1)
  expect(restarted.announce).not.toHaveBeenCalled()
})

it('a failed announcement never fails the write, and is not repeated', async () => {
  const h = harness()
  await h.commit()
  const committed = h.service.get('chain')
  const mine = openHumanAttention(
    committed.outcomeSet!,
    ownReviewAttention({ scope, title: 'Result' }),
    T0
  )
  h.announce.mockImplementationOnce(() => {
    throw new Error('no notification surface')
  })
  const saved = h.service.save({ ...committed, outcomeSet: mine.set }, 1)
  expect(saved.outcomeSet!.attention![0]).toMatchObject({ id: mine.id, notifiedAt: T0 })
  h.service.save(h.service.get('chain'), 1)
  expect(h.announce).toHaveBeenCalledTimes(1)
})
