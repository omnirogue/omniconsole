import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import { isUntouchedFreshStart } from './fresh-session-start'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

let server: AgentHookServer
let seen: AgentHookEventPayload[]

beforeEach(async () => {
  _internals.resetCachesForTests()
  server = new AgentHookServer()
  seen = []
  server.hookEvents.subscribe((event) => seen.push(event))
  await server.start({ env: 'production' })
})

afterEach(() => {
  server.stop()
  vi.restoreAllMocks()
})

describe('the hook event tap', () => {
  it('sees a fresh start, then a prompt the interceptor blocked', async () => {
    await postHookEvent(
      server,
      buildBody({ hook_event_name: 'SessionStart', source: 'startup', session_id: 's1' })
    )
    server.setPromptSubmitInterceptor(async () => ({ decision: 'block', reason: 'held' }))
    const blocked = await postHookEvent(
      server,
      buildBody({ hook_event_name: 'UserPromptSubmit', prompt: 'fix it', session_id: 's1' })
    )
    expect(blocked.status).toBe(200)
    expect(seen.map((event) => [event.paneKey, event.hookEventName])).toEqual([
      [PANE, 'SessionStart'],
      [PANE, 'UserPromptSubmit']
    ])
    expect(isUntouchedFreshStart(seen[0]!)).toBe(true)
    expect(isUntouchedFreshStart(seen[1]!)).toBe(false)
  })

  it('moves its epoch on a stop, a start and a POST it could not read', async () => {
    const started = server.hookEvents.continuityEpoch()
    const env = server.buildPtyEnv()
    await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-OmniConsole-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
      },
      body: '{"paneKey":'
    })
    expect(server.hookEvents.continuityEpoch()).toBeGreaterThan(started)
    const beforeRestart = server.hookEvents.continuityEpoch()
    server.stop()
    await server.start({ env: 'production' })
    expect(server.hookEvents.continuityEpoch()).toBe(beforeRestart + 2)
  })

  it('sees an SSH event with its start source, fenced by that connection alone', () => {
    const lost = vi.fn()
    server.hookEvents.subscribeLost(lost)
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        hookEventName: 'SessionStart',
        sessionStartSource: 'startup',
        source: 'claude',
        launchToken: 'launch-1',
        providerSession: { key: 'session_id', id: 's1' },
        payload: { state: 'done', prompt: '', agentType: 'claude' }
      },
      'devbox'
    )
    expect(seen.at(-1)).toMatchObject({
      paneKey: PANE,
      connectionId: 'devbox',
      sessionStartSource: 'startup',
      launchToken: 'launch-1'
    })
    const epoch = server.hookEvents.continuityEpoch()
    const before = server.hookEvents.connectionEpoch('devbox')
    server.clearStatusEntriesForConnection('devbox')
    expect(server.hookEvents.connectionEpoch('devbox')).toBe(before + 1)
    expect(server.hookEvents.connectionEpoch('other')).toBe(0)
    expect(server.hookEvents.continuityEpoch()).toBe(epoch)
    expect(lost).not.toHaveBeenCalled()
  })
})
