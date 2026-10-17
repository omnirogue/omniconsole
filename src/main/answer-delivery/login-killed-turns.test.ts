import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isLoginFailureText,
  loginKilledState,
  loginKilledTurnFromHook,
  loginKilledTurnFromRollout,
  loginCutOf,
  loginKilledWhileWorking,
  loginResumeText,
  recordLoginKilledTurn,
  setLoginKilledTurnStore,
  turnFailureKind,
  type LoginHookEvent
} from './login-killed-turns'
import { LoginKilledTurnStore, loginKilledTurnsPath } from './login-killed-turns-store'

const ID = '2f0c9f4e-8d1a-4c7e-9b8e-0e6f3f2a1b7c'
const HOME = '/app/claude-accounts/acct-1/auth/session'
const KILLED_AT = Date.UTC(2026, 9, 11, 14, 5)

function hook(overrides: Partial<LoginHookEvent['payload']> = {}): LoginHookEvent {
  return {
    paneKey: 'tab-1:leaf-1',
    worktreeId: 'wt-1',
    connectionId: null,
    providerSession: {
      key: 'session_id',
      id: ID,
      transcriptPath: `${HOME}/projects/-w/${ID}.jsonl`
    },
    stateStartedAt: KILLED_AT,
    payload: {
      state: 'done',
      prompt: '',
      agentType: 'claude',
      failed: true,
      failureReason:
        'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}',
      ...overrides
    }
  }
}

describe('login failure detection', () => {
  it('reads the provider words a login failure prints, and never a usage limit', () => {
    for (const text of [
      'Login expired · Please run /login',
      'OAuth token has expired. Please obtain a new token.',
      'API Error: 401 authentication_error',
      'Your access token could not be refreshed because your refresh token was revoked.'
    ]) {
      expect(isLoginFailureText(text)).toBe(true)
    }
    expect(isLoginFailureText("You've hit your limit · resets 5pm")).toBe(false)
    expect(isLoginFailureText('Overloaded')).toBe(false)
  })

  it('records a local failed Claude turn with its conversation, pane and login home', () => {
    expect(loginKilledTurnFromHook(hook())).toMatchObject({
      ref: `claude:${ID}@local`,
      sessionId: ID,
      provider: 'claude',
      paneKey: 'tab-1:leaf-1',
      worktreeId: 'wt-1',
      home: HOME,
      killedAt: KILLED_AT
    })
  })

  it('ignores remote, replayed, interrupted and non-login turns', () => {
    expect(loginKilledTurnFromHook({ ...hook(), connectionId: 'ssh-1' })).toBeNull()
    expect(loginKilledTurnFromHook({ ...hook(), isReplay: true })).toBeNull()
    expect(loginKilledTurnFromHook(hook({ interrupted: true }))).toBeNull()
    expect(loginKilledTurnFromHook(hook({ failureReason: 'Overloaded' }))).toBeNull()
    expect(loginKilledTurnFromHook(hook({ failed: undefined }))).toBeNull()
  })

  it('reads a Codex rollout failure unless newer work started after it', () => {
    const pane = {
      paneKey: 'tab-2:leaf-2',
      worktreeId: 'wt-1',
      sessionId: 'thread-1',
      transcriptPath: '/Users/maintainer/.codex/sessions/2026/10/11/rollout-thread-1.jsonl'
    }
    const failure = { failedAt: KILLED_AT, reason: 'Please sign in again.', usageLimit: false }
    expect(loginKilledTurnFromRollout(pane, failure, null)).toMatchObject({
      ref: 'codex:thread-1@local',
      home: '/Users/maintainer/.codex'
    })
    expect(
      loginKilledTurnFromRollout(pane, failure, {
        stateStartedAt: KILLED_AT + 1,
        interactive: false
      })
    ).toBeNull()
    expect(loginKilledTurnFromRollout(pane, { ...failure, usageLimit: true }, null)).toBeNull()
  })

  it('tells the conversation exactly when and why it stopped', () => {
    expect(loginResumeText(KILLED_AT, 'UTC')).toBe(
      'Your last turn was cut off at 14:05 by a login failure on this computer. The login works again: continue where you left off.'
    )
  })
})

describe('LoginKilledTurnStore', () => {
  it('keeps one record per failure on disk and never moves a settled one again', () => {
    const path = loginKilledTurnsPath(mkdtempSync(join(tmpdir(), 'login-killed-')))
    const store = new LoginKilledTurnStore(path, () => KILLED_AT + 60_000)
    const seed = loginKilledTurnFromHook(hook())!
    expect(store.add(seed)).toBe(true)
    expect(store.add(seed)).toBe(false)
    expect(new LoginKilledTurnStore(path).list()).toHaveLength(1)

    setLoginKilledTurnStore(store)
    expect(loginKilledState(seed.ref)).toMatchObject({ state: 'pending', settled: false })
    store.update(seed.id, { state: 'resumed' })
    expect(store.update(seed.id, { state: 'pending' })).toBeNull()
    expect(loginKilledState(seed.ref)).toMatchObject({ state: 'resumed', settled: true })
    expect(JSON.parse(readFileSync(path, 'utf-8')).records[0].settledAt).toBe(KILLED_AT + 60_000)
    setLoginKilledTurnStore(null)
  })
})

describe('recording a login-killed turn', () => {
  it('records each failure once, with the model it ran on, and only with a store', () => {
    const seed = loginKilledTurnFromHook(hook({ model: 'claude-opus-5-5' }))
    expect(seed).toMatchObject({ model: 'claude-opus-5-5' })
    expect(recordLoginKilledTurn(seed)).toBe(false)
    const store = new LoginKilledTurnStore(
      loginKilledTurnsPath(mkdtempSync(join(tmpdir(), 'login-killed-')))
    )
    setLoginKilledTurnStore(store)
    expect(recordLoginKilledTurn(seed)).toBe(true)
    expect(recordLoginKilledTurn(seed)).toBe(false)
    expect(
      recordLoginKilledTurn(loginKilledTurnFromHook(hook({ failureReason: 'Overloaded' })))
    ).toBe(false)
    expect(store.list()).toHaveLength(1)
    setLoginKilledTurnStore(null)
  })

  it('names a login failure as authentication even where the classifier misses it', () => {
    expect(turnFailureKind('OAuth token has expired. Please obtain a new token.')).toBe(
      'authentication'
    )
    expect(turnFailureKind('Login expired · Please run /login')).toBe('authentication')
    expect(turnFailureKind("You've hit your limit · resets 5pm")).toBe('usage-limit')
  })

  it("ends a Codex pane's working turn only with an open login failure after it began", () => {
    const store = new LoginKilledTurnStore(
      loginKilledTurnsPath(mkdtempSync(join(tmpdir(), 'login-killed-')))
    )
    setLoginKilledTurnStore(store)
    const pane = {
      paneKey: 'tab-2:leaf-2',
      worktreeId: 'wt-1',
      sessionId: 'thread-1',
      transcriptPath: '/Users/maintainer/.codex/sessions/2026/10/11/rollout-thread-1.jsonl'
    }
    const failure = { failedAt: KILLED_AT, reason: 'Please sign in again.', usageLimit: false }
    const seed = loginKilledTurnFromRollout(pane, failure, null)!
    recordLoginKilledTurn(seed)
    expect(loginKilledWhileWorking('tab-2:leaf-2', KILLED_AT - 60_000)).toBe(
      'Please sign in again.'
    )
    expect(loginKilledWhileWorking('tab-2:leaf-2', KILLED_AT + 1)).toBeNull()
    expect(loginKilledWhileWorking('tab-9:leaf-9', KILLED_AT - 60_000)).toBeNull()
    store.update(seed.id, { state: 'resumed' })
    expect(loginKilledWhileWorking('tab-2:leaf-2', KILLED_AT - 60_000)).toBeNull()
    setLoginKilledTurnStore(null)
  })

  it('tells a delivery its turn was cut off, then where the resume continued it', () => {
    const store = new LoginKilledTurnStore(
      loginKilledTurnsPath(mkdtempSync(join(tmpdir(), 'login-killed-')))
    )
    setLoginKilledTurnStore(store)
    const seed = loginKilledTurnFromHook(hook())!
    recordLoginKilledTurn(seed)
    expect(loginCutOf('tab-1:leaf-1', KILLED_AT - 1)).toEqual({
      state: 'cut_off',
      paneKey: 'tab-1:leaf-1',
      worktreeId: 'wt-1'
    })
    // a failure before the answer was handed over is not its turn
    expect(loginCutOf('tab-1:leaf-1', KILLED_AT + 1)).toBeNull()
    expect(loginCutOf('tab-9:leaf-9', KILLED_AT - 1)).toBeNull()
    store.update(seed.id, { state: 'queued', target: { paneKey: 'tab-3:leaf-3' } })
    expect(loginCutOf('tab-1:leaf-1', KILLED_AT - 1)?.state).toBe('cut_off')
    store.update(seed.id, { state: 'resumed' })
    expect(loginCutOf('tab-1:leaf-1', KILLED_AT - 1)).toEqual({
      state: 'resumed',
      paneKey: 'tab-3:leaf-3'
    })
    // newer work ran after a later failure: nothing is cut off any more
    recordLoginKilledTurn({ ...seed, id: 'later', killedAt: KILLED_AT + 5 })
    store.update('later', { state: 'superseded' })
    expect(loginCutOf('tab-1:leaf-1', KILLED_AT - 1)).toBeNull()
    setLoginKilledTurnStore(null)
  })
})
