import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import {
  claimInterruptedTurn,
  createInterruptedSessionContinuation
} from './interrupted-session-continuation'

const previous: AgentStatusIpcPayload = {
  paneKey: 'pane',
  connectionId: null,
  state: 'working',
  agentType: 'claude',
  prompt: '',
  receivedAt: 100,
  stateStartedAt: 90,
  providerSession: { key: 'session_id', id: 'thread' }
}
const ready: AgentHookEventPayload = {
  paneKey: 'pane',
  connectionId: null,
  launchToken: 'new-launch',
  hookEventName: 'SessionStart',
  providerSession: previous.providerSession,
  payload: { state: 'done', agentType: 'claude', prompt: '', sessionBoundary: true }
}
const directories: string[] = []
afterEach(() =>
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }))
)

function fixture(
  prior: AgentStatusIpcPayload | undefined = previous,
  claim = vi.fn((_key: string) => true)
) {
  let enabled = true
  const send = vi.fn(async (beforeWrite: () => void) => {
    beforeWrite()
    beforeWrite()
  })
  const record = vi.fn()
  return {
    controller: createInterruptedSessionContinuation({
      previous: prior,
      launchToken: 'new-launch',
      enabled: () => enabled,
      claim,
      send,
      record
    }),
    disable: () => {
      enabled = false
    },
    send,
    claim,
    record
  }
}

describe('interrupted session continuation', () => {
  it('waits for both successful resume and a live startup boundary', async () => {
    const f = fixture()
    f.controller.observe(ready)
    expect(f.send).not.toHaveBeenCalled()
    f.controller.commit(true)
    await Promise.resolve()
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.claim).toHaveBeenCalledTimes(1)
    f.controller.observe(ready)
    f.controller.commit(true)
    expect(f.send).toHaveBeenCalledTimes(1)
  })

  it.each(['waiting', 'done', 'blocked', 'unknown'] as const)(
    'never continues prior %s',
    (state) => {
      const f = fixture({ ...previous, state } as AgentStatusIpcPayload)
      f.controller.commit(true)
      f.controller.observe(ready)
      expect(f.send).not.toHaveBeenCalled()
    }
  )

  it('does not continue missing status', () => {
    const f = fixture()
    const send = vi.fn()
    const controller = createInterruptedSessionContinuation({
      previous: undefined,
      launchToken: 'new-launch',
      enabled: () => true,
      claim: f.claim,
      send,
      record: f.record
    })
    controller.commit(true)
    controller.observe(ready)
    expect(send).not.toHaveBeenCalled()
  })

  it('suppresses failed resume even with buffered readiness', () => {
    const f = fixture()
    f.controller.observe(ready)
    f.controller.commit(false)
    expect(f.send).not.toHaveBeenCalled()
  })

  it('suppresses a process exit before readiness', () => {
    const f = fixture()
    f.controller.commit(true)
    f.controller.cancel()
    f.controller.observe(ready)
    expect(f.send).not.toHaveBeenCalled()
  })

  it('honors setting OFF at delivery', () => {
    const f = fixture()
    f.controller.commit(true)
    f.disable()
    f.controller.observe(ready)
    expect(f.send).not.toHaveBeenCalled()
  })

  it.each([
    { ...ready, isReplay: true },
    { ...ready, restoredUnconfirmed: true as const },
    { ...ready, launchToken: 'old-launch' },
    { ...ready, providerSession: { key: 'session_id' as const, id: 'fresh-instead' } },
    {
      ...ready,
      hookEventName: 'PermissionRequest',
      payload: { ...ready.payload, state: 'waiting' as const }
    }
  ])('rejects unproven readiness %#', (event) => {
    const f = fixture()
    f.controller.commit(true)
    f.controller.observe(event)
    expect(f.send).not.toHaveBeenCalled()
  })

  it('a second controller cannot claim the same interrupted turn after restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'continued-turns-'))
    directories.push(directory)
    const claim = vi.fn((key: string) => claimInterruptedTurn(directory, key))
    const first = fixture(previous, claim)
    first.controller.commit(true)
    first.controller.observe(ready)
    await Promise.resolve()
    const second = fixture(previous, claim)
    second.controller.commit(true)
    second.controller.observe(ready)
    await Promise.resolve()
    await Promise.resolve()
    expect(claim.mock.results.map((result) => result.value)).toEqual([true, false])
    expect(second.record).toHaveBeenCalledWith('suppressed', expect.any(Error))
  })
})
