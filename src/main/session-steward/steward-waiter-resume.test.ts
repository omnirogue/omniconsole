import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import type { SessionManageEntry } from '../../shared/session-manage-types'
import type { SessionResumeResult } from '../../shared/session-resume-types'
import {
  reviveWaiter,
  runtimeWaiterResumeDeps,
  type WaiterResumeDeps
} from './steward-waiter-resume'
import { configureStewardSwitches } from './steward-switches'

const REF = 'claude:abc-123@local'

function chain(waits: 'session' | 'jira' | 'none' = 'session'): SessionChain {
  return {
    id: 'chain',
    sourcePaneKey: 'old:leaf',
    outcomeSet: {
      outcomes: [
        {
          id: 'wait',
          conditions: [
            waits === 'session'
              ? { id: 'w', kind: 'event', event: { source: 'session', ref: 'b:1' } }
              : waits === 'jira'
                ? { id: 'w', kind: 'event', event: { source: 'jira', issue: 'OMR-93' } }
                : { id: 'w', kind: 'check', check: { command: 'true' } }
          ]
        }
      ]
    }
  } as unknown as SessionChain
}

function row(paneKey: string, overrides: Partial<SessionManageSidebarRow> = {}) {
  return {
    paneKey,
    title: 'Waiter',
    hostId: 'local',
    folded: false,
    kind: 'terminal',
    worktreeId: 'wt',
    structuredSessionId: null,
    agent: 'claude',
    providerSessionId: 'abc-123',
    ...overrides
  } as SessionManageSidebarRow
}

function deps(overrides: Partial<WaiterResumeDeps> & { rows?: SessionManageSidebarRow[][] } = {}) {
  const pages = overrides.rows ?? [[row('old:leaf')], [row('old:leaf'), row('new:leaf')]]
  let read = 0
  const audit = vi.fn()
  const resume = vi.fn(async (): Promise<SessionResumeResult> => ({
    dryRun: false,
    action: 'resume',
    target: { paneKey: 'new:leaf', title: REF },
    actor: { kind: 'steward', feature: 'rules' },
    ref: REF,
    outcome: 'resumed',
    paneKey: 'new:leaf',
    summary: 'Session steward reopened it in a new tab.'
  }))
  const value: WaiterResumeDeps = {
    enabled: () => true,
    readRows: async () => pages[Math.min(read++, pages.length - 1)]!,
    observe: async () => ({ verdict: 'exited', ref: REF }) as SessionManageEntry,
    reportedRef: () => null,
    resume,
    audit,
    ...overrides
  }
  return { value, resume, audit }
}

describe('reviveWaiter', () => {
  it('resumes an exited waiter and hands back the pane it now lives in', async () => {
    const d = deps()
    await expect(reviveWaiter(d.value, chain(), null)).resolves.toEqual({
      kind: 'resumed',
      source: { worktreeId: 'wt', paneKey: 'new:leaf', kind: 'pty' }
    })
    expect(d.resume).toHaveBeenCalledWith(REF, chain())
    expect(d.audit).toHaveBeenCalledWith(
      'Resumed the waiting session so its next step can continue it: Session steward reopened it in a new tab.',
      { paneKey: 'new:leaf', title: 'Waiter' }
    )
  })

  it('resumes a waiter on a Jira reply, not only on another session', async () => {
    const d = deps()
    await expect(reviveWaiter(d.value, chain('jira'), null)).resolves.toMatchObject({
      kind: 'resumed',
      source: { paneKey: 'new:leaf' }
    })
  })

  it('finds a restarted waiter by its conversation when the resume names no new pane', async () => {
    const d = deps({
      resume: async () =>
        ({ outcome: 'restarted', paneKey: 'old:leaf', summary: 'Resumed.' }) as SessionResumeResult
    })
    await expect(reviveWaiter(d.value, chain(), null)).resolves.toMatchObject({
      kind: 'resumed',
      source: { paneKey: 'new:leaf' }
    })
  })

  it('leaves a live or unreadable waiter to the route, and plans with no session wait alone', async () => {
    const live = deps({ observe: async () => ({ verdict: 'live' }) as SessionManageEntry })
    await expect(reviveWaiter(live.value, chain(), null)).resolves.toBeNull()
    const lost = deps({ observe: async () => ({ verdict: 'unverifiable' }) as SessionManageEntry })
    await expect(reviveWaiter(lost.value, chain(), null)).resolves.toBeNull()
    expect(lost.resume).not.toHaveBeenCalled()
    const other = deps()
    await expect(reviveWaiter(other.value, chain('none'), null)).resolves.toBeNull()
    expect(other.resume).not.toHaveBeenCalled()
    const off = deps({ enabled: () => false })
    await expect(reviveWaiter(off.value, chain(), null)).resolves.toBeNull()
  })

  it('reads Stalled, with the reason, when the waiter cannot be resumed', async () => {
    const refused = deps({
      resume: async () => {
        throw new Error('No transcript for it was found on this computer.')
      }
    })
    await expect(reviveWaiter(refused.value, chain(), null)).resolves.toEqual({
      kind: 'stalled',
      reason:
        'Stalled: “Waiter” exited and could not be resumed: No transcript for it was found on this computer.'
    })
    const unnamed = deps({ observe: async () => ({ verdict: 'exited' }) as SessionManageEntry })
    await expect(reviveWaiter(unnamed.value, chain(), null)).resolves.toMatchObject({
      kind: 'stalled',
      reason: expect.stringContaining('never reported which conversation it was')
    })
  })

  it('never resumes a waiter on another computer', async () => {
    const remote = deps({ rows: [[row('old:leaf', { hostId: 'ssh:devbox' })]] })
    const result = await reviveWaiter(remote.value, chain(), null)
    expect(result).toMatchObject({ kind: 'stalled' })
    expect(remote.resume).not.toHaveBeenCalled()
  })

  it('resumes a closed tab from the conversation its agent last reported', async () => {
    const closed = deps({
      rows: [[], [row('new:leaf')]],
      reportedRef: (paneKey) => (paneKey === 'old:leaf' ? REF : null)
    })
    await expect(reviveWaiter(closed.value, chain(), null)).resolves.toMatchObject({
      kind: 'resumed',
      source: { paneKey: 'new:leaf' }
    })
  })
})

describe('the sessionWaits switch gates the resume itself', () => {
  const restore: (() => void)[] = []
  afterEach(() => {
    for (const undo of restore.splice(0)) {
      undo()
    }
  })

  it('never resumes when the switch is off, or turned off before the resume', async () => {
    const off = deps({ enabled: () => false })
    await expect(reviveWaiter(off.value, chain(), null)).resolves.toBeNull()
    expect(off.resume).not.toHaveBeenCalled()
    let checks = 0
    const flipped = deps({ enabled: () => checks++ === 0 })
    await expect(reviveWaiter(flipped.value, chain(), null)).resolves.toBeNull()
    expect(checks).toBe(2)
    expect(flipped.resume).not.toHaveBeenCalled()
    expect(flipped.audit).not.toHaveBeenCalled()
  })

  it('reads the switch and the env stop from the steward settings', () => {
    const live = runtimeWaiterResumeDeps({} as never, '/tmp/user-data')
    restore.push(configureStewardSwitches({ readSettings: () => ({}), environment: {} }))
    expect(live.enabled()).toBe(true)
    restore.push(configureStewardSwitches({ readSettings: () => ({ sessionWaits: false }) }))
    expect(live.enabled()).toBe(false)
    restore.push(
      configureStewardSwitches({
        readSettings: () => ({}),
        environment: { OMNI_STEWARD_DISABLED: '1' }
      })
    )
    expect(live.enabled()).toBe(false)
  })
})
