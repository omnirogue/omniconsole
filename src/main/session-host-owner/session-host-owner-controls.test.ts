import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionHostRequest } from '../../shared/session-host-protocol'
import { fixtureOperationId } from '../../shared/session-host-wire-fixtures'
import { deliverUnderSessionHostAdmission } from '../session-host/session-host-delivery-admission'
import {
  adoptTestConversation,
  continueRequest,
  FakeSessionHostExecutor,
  MAC_A,
  MAC_B,
  remote,
  testHostProcess,
  testHostRoot,
  withoutOrigin,
  type TestHostRoot
} from '../session-host/session-host-test-fixture'
import type { SessionControlDeps } from '../session-manage/session-manage-control'
import { manageEntry, sidebarRow } from '../session-manage/session-manage-test-fixtures'
import { prepareHostRestart, type OwnerControlDeps } from './session-host-owner-controls'

const CONVERSATION = '2f0c9f4e-8d1a-4c7e-9b8e-0e6f3f2a1b7c'

function owner(confirmRestarted: SessionControlDeps['confirmRestarted']) {
  const notice = vi.fn()
  const deps: OwnerControlDeps = {
    control: {
      interrupt: async () => {},
      stopKeepGoing: () => false,
      lastOutputAt: async () => null,
      stillWorking: async () => false,
      resume: async () => ({ summary: 'Resumed.', tabId: 'tab-7', paneKey: 'tab-7:leaf-7' }),
      confirmRestarted,
      keepCheckpoint: async () => true,
      rename: async () => {
        throw new Error('not used')
      },
      sleep: async () => {},
      now: () => 0
    },
    answer: () => {
      throw new Error('not used')
    },
    answerQuarantine: {} as OwnerControlDeps['answerQuarantine'],
    notice
  }
  const target = {
    session: {
      row: sidebarRow({
        paneKey: 'tab-2:leaf-2',
        tabId: 'tab-2',
        resumable: true,
        providerSessionId: CONVERSATION
      }),
      entry: manageEntry({ verdict: 'exited', state: 'exited', terminal: null }),
      source: null,
      agentProcess: null
    },
    actor: { kind: 'cli' as const },
    unattended: false
  }
  return { deps, target, notice }
}

async function dispatchRestart(confirmRestarted: SessionControlDeps['confirmRestarted']) {
  const { deps, target, notice } = owner(confirmRestarted)
  const prepared = await prepareHostRestart(deps, target)
  if (prepared.kind !== 'dispatch') {
    throw new Error(`refused: ${prepared.refusal.message}`)
  }
  return { settlement: await prepared.dispatch(), notice }
}

describe('a restart another computer asked this owner for', () => {
  it('settles completed only once the new pane’s agent confirms it, with a notice here', async () => {
    const { settlement, notice } = await dispatchRestart(async () => ({
      state: 'same',
      paneKey: 'tab-7:leaf-7'
    }))
    expect(settlement).toMatchObject({
      kind: 'completed',
      result: { summary: expect.stringContaining('confirmed by its agent') }
    })
    expect(notice).toHaveBeenCalledWith(expect.stringContaining('confirmed by its agent'))
  })

  it('carries started_unconfirmed and its reason when its agent never confirmed it', async () => {
    const { settlement, notice } = await dispatchRestart(async () => ({ state: 'unconfirmed' }))
    expect(settlement).toEqual({
      kind: 'completed',
      result: {
        summary: expect.stringContaining('so the resume is unconfirmed'),
        outcome: 'started_unconfirmed',
        reason: 'its agent did not report which conversation it opened within 30 s'
      }
    })
    expect(notice).toHaveBeenCalledWith(expect.stringContaining('so the resume is unconfirmed'))
  })
})

describe('after an unconfirmed restart another computer asked for', () => {
  let root: TestHostRoot | null = null
  afterEach(() => {
    root?.dispose()
    root = null
  })

  it.each(['remote continue', 'local prompt-queue write'] as const)(
    'a later %s still goes through: a restart holds no turn',
    async (next) => {
      root = testHostRoot()
      const executor = new FakeSessionHostExecutor()
      const process = testHostProcess({ root: root.root, incarnation: 'runtime-1', executor })
      const service = await process.service()
      const { conversationId } = await adoptTestConversation(service)
      const { settlement } = await dispatchRestart(async () => ({ state: 'unconfirmed' }))
      executor.afterDispatch = async () => settlement
      const restart: SessionHostRequest<'restart'> = {
        operationId: fixtureOperationId(1),
        conversationId,
        expectedOwnerEpoch: 1,
        expectedTurnRevision: 'turn:1',
        origin: MAC_A,
        action: 'restart',
        payload: {}
      }
      const restarted = await service.execute(withoutOrigin(restart), remote('paired:mac-a'))
      expect(restarted).toMatchObject({
        status: 'ok',
        operation: { state: 'completed', result: { outcome: 'started_unconfirmed' } }
      })
      executor.afterDispatch = null
      executor.turn = 'turn:2'

      if (next === 'remote continue') {
        const continued = await service.execute(
          withoutOrigin(
            continueRequest(2, conversationId, { expectedTurnRevision: 'turn:2', origin: MAC_B })
          ),
          remote('paired:mac-b', MAC_B)
        )
        expect(continued).toMatchObject({ status: 'ok', operation: { state: 'completed' } })
        return
      }
      const deliver = vi.fn(async () => ({ door: 'pty' as const, deliveredAt: 42 }))
      await expect(
        deliverUnderSessionHostAdmission({
          host: process,
          source: { worktreeId: 'wt-1', paneKey: 'tab-1:claude-session-1', kind: 'pty' },
          text: 'Next step.',
          operationId: fixtureOperationId(3),
          admission: { writer: 'prompt-queue' },
          deliver
        })
      ).resolves.toMatchObject({ door: 'pty' })
      expect(deliver).toHaveBeenCalledTimes(1)
    }
  )
})
