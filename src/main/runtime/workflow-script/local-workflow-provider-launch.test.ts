import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resolveCodexHomeProcessLockKey,
  withCodexHomeProcessLock
} from '../../codex-cli/codex-home-process-lock'
import type { OrcaRuntimeService } from '../omni-runtime'
import type { ResolvedLocalWorkflowSeat } from '../../../shared/local-workflow-seats'
import type { LocalWorkflowHostSnapshot } from './local-workflow-host-snapshot'
import type { WorkflowProgramCall } from './workflow-program-context'
import { NOOP_WORKFLOW_LIVE_OBSERVER } from './workflow-live-observer'
import { runWithWorkflowAccount, type WorkflowAttemptAccount } from './workflow-durable-call'
import { WorkflowScriptSlots } from './workflow-script-slots'
import { workflowAccount } from './local-workflow-provider-launch'

// A private Codex account home, so no test ever reads the machine's real Codex login.
const codexHome = mkdtempSync(join(tmpdir(), 'workflow-codex-account-'))
const runtime = {
  getAgentAccountSettings: () => ({
    agentAccountProfiles: [{ id: 'codex', label: 'Codex', agent: 'codex', configDir: codexHome }]
  })
} as unknown as OrcaRuntimeService
const HOUR = 60 * 60_000
const DAY = 24 * HOUR
const jwt = (payload: object) =>
  ['header', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'signature'].join('.')
/** Writes the account's Codex login: access token expiry and last refresh relative to now. */
function codexLogin(expiresInMs: number, refreshedAgoMs: number): void {
  const now = Date.now()
  writeFileSync(
    join(codexHome, 'auth.json'),
    JSON.stringify({
      tokens: {
        access_token: jwt({ exp: Math.floor((now + expiresInMs) / 1000) }),
        refresh_token: 'fixture-refresh',
        account_id: 'fixture-account'
      },
      last_refresh: new Date(now - refreshedAgoMs).toISOString()
    })
  )
}
const savedGrokHome = process.env.GROK_HOME
const directories: string[] = []
// By default the login is due for a refresh, so Codex runs take the account one at a time.
beforeEach(() => codexLogin(DAY, 9 * DAY))
afterAll(() => rmSync(codexHome, { recursive: true, force: true }))
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  if (savedGrokHome === undefined) {
    delete process.env.GROK_HOME
  } else {
    process.env.GROK_HOME = savedGrokHome
  }
})

function seat(agent: ResolvedLocalWorkflowSeat['agent']): ResolvedLocalWorkflowSeat {
  return {
    id: agent,
    agent,
    accountId: agent === 'codex' ? 'profile:codex' : `system:${agent}`,
    model: `${agent}-model`,
    effort: null,
    lineage: 'unknown',
    policyRevision: 'test-v1'
  }
}

const snapshot = {
  access: 'workspace-read',
  seats: [seat('claude'), seat('codex'), seat('grok')]
} as unknown as LocalWorkflowHostSnapshot

function call(seatId: string, id = `answer/${seatId}`): WorkflowProgramCall {
  return {
    id,
    seatId,
    prompt: 'Question',
    dependencies: [],
    schema: {},
    validateSemantics: () => null
  }
}

/** Work that records when it starts and finishes only when released. */
function gated(log: string[], name: string) {
  let release = () => {}
  const done = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    release,
    work: async () => {
      log.push(`start ${name}`)
      await done
      log.push(`end ${name}`)
      return name
    }
  }
}

/** A Grok account whose login expires in `expiresInMs`; call it again to change the expiry. */
function grokLogin(expiresInMs: number, account = process.env.GROK_HOME): string {
  if (!account || !directories.includes(account)) {
    account = mkdtempSync(join(tmpdir(), 'workflow-grok-account-'))
    directories.push(account)
  }
  const expires_at = new Date(Date.now() + expiresInMs).toISOString()
  writeFileSync(join(account, 'auth.json'), JSON.stringify({ login: { expires_at } }))
  process.env.GROK_HOME = account
  return account
}

/** Runs calls the way the durable agent does: a slot first, then the account. */
function admitter(account: WorkflowAttemptAccount, signal = new AbortController().signal) {
  return (slots: WorkflowScriptSlots, current: WorkflowProgramCall, work: () => Promise<string>) =>
    runWithWorkflowAccount(slots, account, current, work, signal)
}

const idle = () => new Promise((resolve) => setTimeout(resolve, 50))

describe('workflow account', () => {
  it('runs Codex launches of one account one at a time, giving the slot back while waiting', async () => {
    const waiting = vi.fn()
    const admit = admitter(
      workflowAccount(runtime, snapshot, { ...NOOP_WORKFLOW_LIVE_OBSERVER, waiting })
    )
    const slots = new WorkflowScriptSlots(2)
    const log: string[] = []
    const first = gated(log, 'first')
    const second = gated(log, 'second')
    // Why one after the other: each call reads the login before it tries the account, so two
    // calls admitted together race for it; the second is admitted once the first holds it.
    const runs = [admit(slots, call('codex', 'answer/1'), first.work)]
    await vi.waitFor(() => expect(log).toEqual(['start first']))
    runs.push(admit(slots, call('codex', 'answer/2'), second.work))
    await vi.waitFor(() => expect(waiting.mock.calls).toEqual([['answer/2', 'account']]))
    expect(log).toEqual(['start first'])
    // The waiting call holds no slot.
    expect(slots.running).toBe(1)
    first.release()
    await vi.waitFor(() => expect(log).toEqual(['start first', 'end first', 'start second']))
    expect(waiting.mock.calls).toEqual([
      ['answer/2', 'account'],
      ['answer/2', 'slot']
    ])
    second.release()
    expect(await Promise.all(runs)).toEqual(['first', 'second'])
  })

  it('runs Codex launches in parallel while the login stays valid well past the call', async () => {
    codexLogin(9 * DAY, HOUR)
    const waiting = vi.fn()
    const admit = admitter(
      workflowAccount(runtime, snapshot, { ...NOOP_WORKFLOW_LIVE_OBSERVER, waiting })
    )
    const slots = new WorkflowScriptSlots(2)
    const log: string[] = []
    const first = gated(log, 'first')
    const second = gated(log, 'second')
    const runs = [
      admit(slots, call('codex', 'answer/1'), first.work),
      admit(slots, call('codex', 'answer/2'), second.work)
    ]
    await vi.waitFor(() => expect([...log].sort()).toEqual(['start first', 'start second']))
    expect(waiting).not.toHaveBeenCalled()
    first.release()
    second.release()
    expect(await Promise.all(runs)).toEqual(['first', 'second'])
  })

  it('serialises Codex launches that could refresh the login until one has refreshed it', async () => {
    // The access token lasts 40 more minutes: less than a twenty-minute call plus the margin.
    codexLogin(40 * 60_000, HOUR)
    const admit = admitter(workflowAccount(runtime, snapshot))
    const slots = new WorkflowScriptSlots(3)
    const log: string[] = []
    const first = gated(log, 'first')
    const second = gated(log, 'second')
    const third = gated(log, 'third')
    const long = (id: string) => ({ ...call('codex', id), timeoutMs: 20 * 60_000 })
    const runs = [admit(slots, long('find/1'), first.work)]
    await vi.waitFor(() => expect(log).toEqual(['start first']))
    runs.push(admit(slots, long('find/2'), second.work))
    await idle()
    expect(log).toEqual(['start first'])
    expect(slots.running).toBe(1)
    // The first run refreshed the rotating login, so the rest no longer need the account.
    codexLogin(10 * DAY, 0)
    first.release()
    await vi.waitFor(() => expect(log).toEqual(['start first', 'end first', 'start second']))
    runs.push(admit(slots, long('find/3'), third.work))
    await vi.waitFor(() => expect(log).toContain('start third'))
    second.release()
    third.release()
    expect(await Promise.all(runs)).toEqual(['first', 'second', 'third'])
  })

  it('keeps Codex launches one at a time when the login cannot be read', async () => {
    writeFileSync(join(codexHome, 'auth.json'), 'not json')
    const admit = admitter(workflowAccount(runtime, snapshot))
    const slots = new WorkflowScriptSlots(2)
    const log: string[] = []
    const first = gated(log, 'first')
    const second = gated(log, 'second')
    const runs = [admit(slots, call('codex', 'answer/1'), first.work)]
    await vi.waitFor(() => expect(log).toEqual(['start first']))
    runs.push(admit(slots, call('codex', 'answer/2'), second.work))
    await idle()
    expect(log).toEqual(['start first'])
    first.release()
    await vi.waitFor(() => expect(log).toContain('start second'))
    second.release()
    expect(await Promise.all(runs)).toEqual(['first', 'second'])
  })

  it('never holds the Codex account while a call waits for a slot', async () => {
    const admit = admitter(workflowAccount(runtime, snapshot))
    const full = new WorkflowScriptSlots(1)
    const log: string[] = []
    const claude = gated(log, 'claude')
    const queued = gated(log, 'queued')
    const other = gated(log, 'other')
    const runs = [admit(full, call('claude'), claude.work)]
    await vi.waitFor(() => expect(log).toEqual(['start claude']))
    runs.push(admit(full, call('codex', 'answer/queued'), queued.work))
    // Another run with free slots, and the usage refresh, still use the account meanwhile.
    runs.push(admit(new WorkflowScriptSlots(1), call('codex', 'answer/other'), other.work))
    await vi.waitFor(() => expect(log).toEqual(['start claude', 'start other']))
    other.release()
    const key = resolveCodexHomeProcessLockKey(codexHome)
    await expect(withCodexHomeProcessLock(key, async () => 'refreshed')).resolves.toBe('refreshed')
    expect(log).not.toContain('start queued')
    claude.release()
    await vi.waitFor(() => expect(log).toContain('start queued'))
    queued.release()
    expect(await Promise.all(runs)).toEqual(['claude', 'queued', 'other'])
  })

  it('stops waiting for the account when the run is cancelled', async () => {
    const account = workflowAccount(runtime, snapshot)
    const log: string[] = []
    const holder = gated(log, 'holder')
    const running = admitter(account)(
      new WorkflowScriptSlots(1),
      call('codex', 'answer/1'),
      holder.work
    )
    await vi.waitFor(() => expect(log).toEqual(['start holder']))
    const controller = new AbortController()
    const slots = new WorkflowScriptSlots(1)
    const waiter = admitter(account, controller.signal)(
      slots,
      call('codex', 'answer/2'),
      async () => 'never'
    )
    await vi.waitFor(() => expect(slots.running).toBe(0))
    controller.abort(new Error('Workflow stopped'))
    await expect(waiter).rejects.toThrow('Workflow stopped')
    holder.release()
    expect(await running).toBe('holder')
  })

  it('never serialises other routes, or streamed Grok while its login outlasts the call', async () => {
    grokLogin(24 * 60 * 60_000)
    const waiting = vi.fn()
    const admit = admitter(
      workflowAccount(runtime, snapshot, { ...NOOP_WORKFLOW_LIVE_OBSERVER, waiting })
    )
    const slots = new WorkflowScriptSlots(3)
    const log: string[] = []
    const calls = [gated(log, 'claude'), gated(log, 'grok-1'), gated(log, 'grok-2')]
    const runs = [
      admit(slots, call('claude'), calls[0].work),
      admit(slots, call('grok', 'answer/1'), calls[1].work),
      admit(slots, call('grok', 'answer/2'), calls[2].work)
    ]
    await vi.waitFor(() =>
      expect([...log].sort()).toEqual(['start claude', 'start grok-1', 'start grok-2'])
    )
    expect(waiting).not.toHaveBeenCalled()
    calls.forEach((entry) => entry.release())
    await Promise.all(runs)
  })

  it('serialises streamed Grok launches that could outlive the login until one refreshes it', async () => {
    const account = grokLogin(60_000)
    const admit = admitter(workflowAccount(runtime, snapshot))
    const slots = new WorkflowScriptSlots(3)
    const log: string[] = []
    const first = gated(log, 'first')
    const second = gated(log, 'second')
    const third = gated(log, 'third')
    const runs = [admit(slots, call('grok', 'answer/1'), first.work)]
    await vi.waitFor(() => expect(log).toEqual(['start first']))
    runs.push(admit(slots, call('grok', 'answer/2'), second.work))
    await idle()
    expect(log).toEqual(['start first'])
    expect(slots.running).toBe(1)
    // The first run carried a fresh login back, so the rest no longer need the account.
    grokLogin(24 * 60 * 60_000, account)
    first.release()
    await vi.waitFor(() => expect(log).toEqual(['start first', 'end first', 'start second']))
    runs.push(admit(slots, call('grok', 'answer/3'), third.work))
    await vi.waitFor(() => expect(log).toContain('start third'))
    second.release()
    third.release()
    expect(await Promise.all(runs)).toEqual(['first', 'second', 'third'])
  })

  it('judges the Grok login once the slot is held, so a long slot wait cannot leave it stale', async () => {
    const account = grokLogin(24 * 60 * 60_000)
    const waiting = vi.fn()
    const admit = admitter(
      workflowAccount(runtime, snapshot, { ...NOOP_WORKFLOW_LIVE_OBSERVER, waiting })
    )
    const full = new WorkflowScriptSlots(1)
    const log: string[] = []
    const claude = gated(log, 'claude')
    const late = gated(log, 'late')
    const holder = gated(log, 'holder')
    const runs = [admit(full, call('claude'), claude.work)]
    await vi.waitFor(() => expect(log).toEqual(['start claude']))
    // Queued while the login still outlasts it, then left waiting for a slot.
    runs.push(admit(full, call('grok', 'answer/late'), late.work))
    grokLogin(60_000, account)
    runs.push(admit(new WorkflowScriptSlots(1), call('grok', 'answer/holder'), holder.work))
    await vi.waitFor(() => expect(log).toEqual(['start claude', 'start holder']))
    claude.release()
    await vi.waitFor(() => expect(waiting).toHaveBeenCalledWith('answer/late', 'account'))
    expect(full.running).toBe(0)
    expect(log).not.toContain('start late')
    holder.release()
    await vi.waitFor(() => expect(log).toContain('start late'))
    expect(log.indexOf('end holder')).toBeLessThan(log.indexOf('start late'))
    late.release()
    expect(await Promise.all(runs)).toEqual(['claude', 'late', 'holder'])
  })
})
