import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionHostLiveObservation } from './session-host-executor'
import type { SessionHostRegistration } from './session-host-journal'
import {
  adoptTestConversation,
  FakeSessionHostExecutor,
  testHostProcess,
  testHostRoot,
  type TestHostRoot
} from './session-host-test-fixture'

let host: TestHostRoot
beforeEach(() => {
  host = testHostRoot()
})
afterEach(() => {
  host.dispose()
})

async function hostWith(register: FakeSessionHostExecutor['register']) {
  const executor = new FakeSessionHostExecutor()
  executor.register = register
  const process = testHostProcess({ root: host.root, incarnation: 'runtime-1', executor })
  return await process.service()
}

describe('what a host lists for another computer', () => {
  it('includes a session it registers on being asked, not only at its next pass', async () => {
    const service = await hostWith(async () => {
      await adoptTestConversation(service, 'claude-session-new')
    })

    const observed = await service.observe({})

    expect(observed.status === 'ok' && observed.sessions.map((row) => row.provider)).toEqual([
      { agent: 'claude', sessionId: 'claude-session-new' }
    ])
  })

  it('still answers with what it has when registering fails', async () => {
    const service = await hostWith(async () => {
      throw new Error('inventory unreadable')
    })
    await adoptTestConversation(service, 'claude-session-1')

    const observed = await service.observe({})

    expect(observed.status === 'ok' && observed.sessions).toHaveLength(1)
  })
})

/** Sees a session on its pane only for the provider conversations it is given. */
class PaneExecutor extends FakeSessionHostExecutor {
  constructor(private readonly onPanes: ReadonlySet<string>) {
    super()
  }

  override async observe(
    registrations: readonly SessionHostRegistration[]
  ): Promise<ReadonlyMap<string, SessionHostLiveObservation>> {
    return new Map(
      registrations.map((registration): [string, SessionHostLiveObservation] => [
        registration.conversationId,
        this.onPanes.has(registration.provider.sessionId)
          ? {
              verdict: 'live',
              turnRevision: this.turn,
              ref: { paneKey: registration.binding?.paneKey ?? null }
            }
          : { verdict: 'unverifiable', turnRevision: null }
      ])
    )
  }
}

describe('registrations an earlier process left behind', () => {
  async function restartedWith(onPanes: readonly string[]) {
    const first = await testHostProcess({ root: host.root, incarnation: 'runtime-1' }).service()
    for (const sessionId of ['claude-closed', 'claude-still-open']) {
      await adoptTestConversation(first, sessionId)
    }
    const executor = new PaneExecutor(new Set(onPanes))
    const second = testHostProcess({
      root: host.root,
      incarnation: 'runtime-2',
      executor,
      dead: ['runtime-1']
    })
    return await second.service()
  }

  const listed = (
    observed: Awaited<ReturnType<Awaited<ReturnType<typeof restartedWith>>['observe']>>
  ) => (observed.status === 'ok' ? observed.sessions.map((row) => row.provider?.sessionId) : [])

  it('are not listed once nothing here holds them', async () => {
    const service = await restartedWith(['claude-still-open'])

    expect(listed(await service.observe({}))).toEqual(['claude-still-open'])
  })

  it('stay listed while this process holds a session for them, before it registers them again', async () => {
    const service = await restartedWith(['claude-closed', 'claude-still-open'])

    expect(listed(await service.observe({}))).toEqual(['claude-closed', 'claude-still-open'])
  })

  it('stay listed when one is asked for by its id', async () => {
    const service = await restartedWith(['claude-still-open'])
    const closed = Object.values(service.store.snapshot()!.conversations).find(
      (registration) => registration.provider.sessionId === 'claude-closed'
    )!

    const observed = await service.observe({ conversationIds: [closed.conversationId] })

    expect(listed(observed)).toEqual(['claude-closed'])
  })

  it('a session this process registered stays listed even when it sees no pane for it', async () => {
    const service = await restartedWith(['claude-still-open'])
    await adoptTestConversation(service, 'claude-new-here')

    expect(listed(await service.observe({}))).toEqual(['claude-still-open', 'claude-new-here'])
  })
})
