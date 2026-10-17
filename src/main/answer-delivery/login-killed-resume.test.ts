import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AccountLoginReadiness } from './account-login-ready'
import {
  LoginResumeRefusal,
  loginResumePass,
  type LoginResumeDeps,
  type LoginResumeHolder,
  type LoginResumePane,
  type LoginResumeQueueState,
  type LoginResumeTurn
} from './login-killed-resume'
import { loginKilledTurnId, loginResumePromptId } from './login-killed-turns'
import { LoginKilledTurnStore, loginKilledTurnsPath } from './login-killed-turns-store'

const KILLED_AT = Date.UTC(2026, 9, 11, 14, 5)
const REF = 'claude:2f0c9f4e-8d1a-4c7e-9b8e-0e6f3f2a1b7c@local'
const OWN: LoginResumePane = { paneKey: 'tab-1:leaf-1', worktreeId: 'wt-1' }
const REOPENED: LoginResumePane = { paneKey: 'tab-7:leaf-7', worktreeId: 'wt-1' }

function harness(clock = { now: KILLED_AT + 60_000 }) {
  const store = new LoginKilledTurnStore(
    loginKilledTurnsPath(mkdtempSync(join(tmpdir(), 'login-resume-'))),
    () => clock.now
  )
  const queue = new Map<string, LoginResumeQueueState>()
  const state = {
    login: { ready: true, label: 'sal@acct-1' } as AccountLoginReadiness,
    holder: { kind: 'live', pane: OWN } as LoginResumeHolder,
    turn: { state: 'done', startedAt: KILLED_AT, boundary: false } as LoginResumeTurn | null,
    window: true,
    proven: true
  }
  const resume = vi.fn(async (): Promise<LoginResumePane> => {
    state.holder = { kind: 'live', pane: REOPENED }
    state.turn = { state: 'idle', startedAt: clock.now, boundary: true }
    return REOPENED
  })
  const enqueue = vi.fn(async (_pane: LoginResumePane, id: string, _text: string) => {
    if (!state.proven) {
      return false
    }
    queue.set(id, 'queued')
    return true
  })
  const deps: LoginResumeDeps = {
    store,
    loginReady: async () => state.login,
    findPane: async () => state.holder,
    turn: () => state.turn,
    windowAttached: () => state.window,
    resume,
    enqueue,
    queueState: (_pane, id) => queue.get(id) ?? 'missing',
    now: () => clock.now,
    timeZone: 'UTC'
  }
  const add = (killedAt = KILLED_AT, ref = REF) => {
    const id = loginKilledTurnId(ref, killedAt)
    store.add({
      id,
      ref,
      sessionId: ref.split(':')[1]!.split('@')[0]!,
      provider: 'claude',
      paneKey: OWN.paneKey,
      worktreeId: OWN.worktreeId,
      home: '/app/claude-accounts/acct-1/auth/session',
      killedAt,
      reason: 'OAuth token has expired.'
    })
    return id
  }
  return { store, queue, state, resume, enqueue, deps, add, clock }
}

describe('login-killed resume', () => {
  it('waits for the login, then continues the live pane once and settles when it is taken up', async () => {
    const h = harness()
    const id = h.add()
    h.state.login = { ready: false, held: 'login_failed', reason: 'checking sal@acct-1’s login' }
    await loginResumePass(h.deps)
    expect(h.store.get(id)).toMatchObject({ state: 'pending', heldReason: 'login_failed' })
    expect(h.enqueue).not.toHaveBeenCalled()

    h.state.login = { ready: true, label: 'sal@acct-1' }
    await loginResumePass(h.deps)
    await loginResumePass(h.deps)
    const promptId = loginResumePromptId({ id })
    expect(h.enqueue).toHaveBeenCalledTimes(1)
    expect(h.enqueue.mock.calls[0]![2]).toContain('cut off at 14:05 by a login failure')
    expect(h.store.get(id)).toMatchObject({ state: 'queued', promptId, target: OWN })

    h.queue.set(promptId, 'delivered')
    h.state.turn = { state: 'working', startedAt: h.clock.now + 1, boundary: false }
    await loginResumePass(h.deps)
    expect(h.store.get(id)).toMatchObject({ state: 'resumed' })
    expect(h.resume).not.toHaveBeenCalled()
  })

  it('reopens the same conversation when its pane is gone, then queues the prompt there', async () => {
    const h = harness()
    const id = h.add()
    h.state.holder = { kind: 'none' }
    await loginResumePass(h.deps)
    expect(h.resume).toHaveBeenCalledTimes(1)
    expect(h.store.get(id)).toMatchObject({
      state: 'queued',
      target: REOPENED,
      reopenedAt: h.clock.now
    })
    expect(h.enqueue.mock.calls[0]![0]).toEqual(REOPENED)
  })

  it('holds a refused reopen and never retries it, and waits for a window', async () => {
    const h = harness()
    const id = h.add()
    h.state.holder = { kind: 'none' }
    h.state.window = false
    await loginResumePass(h.deps)
    expect(h.store.get(id)).toMatchObject({ state: 'pending', heldReason: 'no_window' })

    h.state.window = true
    h.resume.mockRejectedValueOnce(
      new LoginResumeRefusal('protection', 'The person deleted this conversation.')
    )
    await loginResumePass(h.deps)
    await loginResumePass(h.deps)
    expect(h.resume).toHaveBeenCalledTimes(1)
    expect(h.store.get(id)).toMatchObject({ state: 'held', heldReason: 'protection' })
    expect(h.enqueue).not.toHaveBeenCalled()
  })

  it('holds a reopen that failed without refusing, since something may have started', async () => {
    const h = harness()
    const id = h.add()
    h.state.holder = { kind: 'none' }
    h.resume.mockRejectedValueOnce(new Error('spawn timed out'))
    await loginResumePass(h.deps)
    await loginResumePass(h.deps)
    expect(h.resume).toHaveBeenCalledTimes(1)
    expect(h.store.get(id)).toMatchObject({ state: 'held', heldReason: 'unverifiable' })
  })

  it('reopens one conversation at a time', async () => {
    const h = harness()
    const first = h.add(KILLED_AT, REF)
    const second = h.add(KILLED_AT + 1, 'codex:thread-2@local')
    h.state.holder = { kind: 'none' }
    h.resume.mockImplementation(async () => REOPENED)
    h.state.proven = false
    await loginResumePass(h.deps)
    expect(h.resume).toHaveBeenCalledTimes(1)
    expect(h.store.get(first)).toMatchObject({ state: 'reopening' })
    expect(h.store.get(second)).toMatchObject({ state: 'pending' })
  })

  it('never sends again after a restart: a reopen without proof or a vanished entry is held', async () => {
    const h = harness()
    const reopening = h.add()
    h.store.update(reopening, { state: 'reopening', reopenedAt: h.clock.now })
    h.state.holder = { kind: 'none' }
    await loginResumePass(h.deps)
    expect(h.store.get(reopening)).toMatchObject({ state: 'reopening' })
    h.clock.now += 6 * 60_000
    await loginResumePass(h.deps)
    expect(h.store.get(reopening)).toMatchObject({ state: 'held', heldReason: 'unverifiable' })
    expect(h.resume).not.toHaveBeenCalled()

    const queued = h.add(KILLED_AT + 5, 'codex:thread-3@local')
    h.store.update(queued, { state: 'queued', promptId: loginResumePromptId({ id: queued }) })
    await loginResumePass(h.deps)
    expect(h.store.get(queued)).toMatchObject({ state: 'held', heldReason: 'unverifiable' })
    expect(h.enqueue).not.toHaveBeenCalled()
  })

  it('adopts a prompt already queued under its id instead of queueing it twice', async () => {
    const h = harness()
    const id = h.add()
    h.queue.set(loginResumePromptId({ id }), 'sending')
    await loginResumePass(h.deps)
    expect(h.enqueue).not.toHaveBeenCalled()
    expect(h.store.get(id)).toMatchObject({ state: 'queued' })
  })

  it('settles a failed send as held: unsent is an error, anything else unverifiable', async () => {
    const h = harness()
    const id = h.add()
    await loginResumePass(h.deps)
    h.queue.set(loginResumePromptId({ id }), 'failed-unsent')
    await loginResumePass(h.deps)
    expect(h.store.get(id)).toMatchObject({ state: 'held', heldReason: 'error' })
  })

  it('supersedes it when newer work ran in the pane or a later failure replaced it', async () => {
    const h = harness()
    const older = h.add(KILLED_AT)
    const newer = h.add(KILLED_AT + 30_000)
    h.state.turn = { state: 'working', startedAt: KILLED_AT + 40_000, boundary: false }
    await loginResumePass(h.deps)
    expect(h.store.get(older)).toMatchObject({ state: 'superseded' })
    expect(h.store.get(newer)).toMatchObject({
      state: 'superseded',
      detail: 'newer work ran in it'
    })
    expect(h.enqueue).not.toHaveBeenCalled()
  })

  it('holds a failure a day old, and one whose conversation was already continued twice today', async () => {
    const h = harness({ now: KILLED_AT + 25 * 60 * 60_000 })
    const stale = h.add()
    await loginResumePass(h.deps)
    expect(h.store.get(stale)).toMatchObject({ state: 'held', heldReason: 'login_failed' })

    const looped = harness()
    for (const at of [KILLED_AT - 20_000, KILLED_AT - 10_000]) {
      looped.store.update(looped.add(at), { state: 'resumed' })
    }
    const third = looped.add()
    await loginResumePass(looped.deps)
    expect(looped.store.get(third)).toMatchObject({ state: 'held', heldReason: 'login_failed' })
    expect(looped.enqueue).not.toHaveBeenCalled()
  })

  it('keeps it pending while its pane cannot be verified', async () => {
    const h = harness()
    const id = h.add()
    h.state.holder = { kind: 'blocked', reason: '“Docs” cannot be verified, so it is not reopened' }
    await loginResumePass(h.deps)
    expect(h.store.get(id)).toMatchObject({ state: 'pending', heldReason: 'unverifiable' })
    expect(h.resume).not.toHaveBeenCalled()
  })
})
