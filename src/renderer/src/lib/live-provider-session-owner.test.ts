import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  claimProviderSessionLaunch,
  collectUnverifiedProviderSessionOwners,
  findLiveProviderSessionOwner,
  findLiveProviderSessionOwnerWithProbe,
  holdProviderSessionLaunchClaim,
  isPaneBoundToLivePty,
  resetProviderSessionLaunchClaimsForTests
} from './live-provider-session-owner'

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'
const THREAD = { key: 'session_id' as const, id: 'thread-1' }
const ME = `tab-me:${LEAF_A}`
const OTHER = `tab-other:${LEAF_B}`

function status(paneKey: string, overrides: Record<string, unknown> = {}) {
  return {
    paneKey,
    state: 'done',
    prompt: '',
    agentType: 'codex',
    updatedAt: 1,
    stateStartedAt: 1,
    stateHistory: [],
    providerSession: THREAD,
    ...overrides
  } as never
}

function state(overrides: Record<string, unknown> = {}) {
  return {
    agentStatusByPaneKey: {},
    tabsByWorktree: { wt: [{ id: 'tab-me', ptyId: 'me-pty' }, { id: 'tab-other', ptyId: null }] },
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: { 'tab-other': { ptyIdsByLeafId: { [LEAF_B]: 'other-pty' } } },
    ...overrides
  } as Parameters<typeof findLiveProviderSessionOwner>[0]
}

const query = { agent: 'codex', providerSession: THREAD, excludePaneKey: ME }

describe('live provider session owner', () => {
  beforeEach(() => {
    resetProviderSessionLaunchClaimsForTests()
  })

  it('counts a live turn on a live pane PTY, and a done row only while its agent is in the foreground', () => {
    const working = state({
      agentStatusByPaneKey: { [OTHER]: status(OTHER, { state: 'working' }) },
      ptyIdsByTabId: { 'tab-other': ['other-pty'] }
    })
    expect(findLiveProviderSessionOwner(working, query)).toBe(OTHER)
    expect(isPaneBoundToLivePty(working, OTHER)).toBe(true)
    const idleAtPrompt = state({
      agentStatusByPaneKey: { [OTHER]: status(OTHER) },
      ptyIdsByTabId: { 'tab-other': ['other-pty'] },
      paneForegroundAgentByPaneKey: { [OTHER]: { agent: 'codex', shellForeground: false } }
    })
    expect(findLiveProviderSessionOwner(idleAtPrompt, query)).toBe(OTHER)
  })

  it('never counts a done row whose agent exited: the PTY is back at its shell', () => {
    // The row outlives the agent (agent-status-listeners keeps done rows); the PTY stays bound.
    const exited = state({
      agentStatusByPaneKey: { [OTHER]: status(OTHER) },
      ptyIdsByTabId: { 'tab-other': ['other-pty'] },
      paneForegroundAgentByPaneKey: { [OTHER]: { agent: null, shellForeground: true } }
    })
    expect(findLiveProviderSessionOwner(exited, query)).toBeNull()
    expect(collectUnverifiedProviderSessionOwners(exited, query)).toEqual([])
  })

  it('probes a done row on a bound PTY with no foreground sample, and trusts only a non-shell answer', async () => {
    const unsampled = state({
      agentStatusByPaneKey: { [OTHER]: status(OTHER) },
      ptyIdsByTabId: { 'tab-other': ['other-pty'] }
    })
    expect(findLiveProviderSessionOwner(unsampled, query)).toBeNull()
    expect(collectUnverifiedProviderSessionOwners(unsampled, query)).toEqual([
      { paneKey: OTHER, ptyId: 'other-pty', bound: true, done: true }
    ])
    const hasPty = vi.fn(async () => true)
    await expect(
      findLiveProviderSessionOwnerWithProbe(unsampled, query, hasPty, async () => 'zsh')
    ).resolves.toBeNull()
    await expect(
      findLiveProviderSessionOwnerWithProbe(unsampled, query, hasPty, async () => null)
    ).resolves.toBeNull()
    await expect(
      findLiveProviderSessionOwnerWithProbe(unsampled, query, hasPty, async () => 'codex')
    ).resolves.toBe(OTHER)
    // A bound PTY needs no liveness probe.
    expect(hasPty).not.toHaveBeenCalled()
  })

  it('ignores a row whose pane PTY this renderer does not hold, but offers it for a probe', () => {
    const cold = state({ agentStatusByPaneKey: { [OTHER]: status(OTHER) } })
    expect(findLiveProviderSessionOwner(cold, query)).toBeNull()
    expect(collectUnverifiedProviderSessionOwners(cold, query)).toEqual([
      { paneKey: OTHER, ptyId: 'other-pty', bound: false, done: true }
    ])
  })

  it('never counts the asking pane, another agent, or another thread', () => {
    const bound = { ptyIdsByTabId: { 'tab-me': ['me-pty'], 'tab-other': ['other-pty'] } }
    expect(
      findLiveProviderSessionOwner(state({ ...bound, agentStatusByPaneKey: { [ME]: status(ME) } }), query)
    ).toBeNull()
    expect(
      findLiveProviderSessionOwner(
        state({ ...bound, agentStatusByPaneKey: { [OTHER]: status(OTHER, { agentType: 'claude' }) } }),
        query
      )
    ).toBeNull()
    expect(
      findLiveProviderSessionOwner(
        state({
          ...bound,
          agentStatusByPaneKey: {
            [OTHER]: status(OTHER, { providerSession: { key: 'session_id', id: 'thread-2' } })
          }
        }),
        query
      )
    ).toBeNull()
  })

  it('never counts a queued startup or a sleeping record: neither has a live PTY', () => {
    const queued = state({
      pendingStartupByTabId: {
        'tab-other': { launchAgent: 'codex', resumeProviderSession: THREAD }
      },
      sleepingAgentSessionsByPaneKey: {
        [OTHER]: { paneKey: OTHER, agent: 'codex', providerSession: THREAD, state: 'done' }
      }
    })
    expect(findLiveProviderSessionOwner(queued, query)).toBeNull()
    expect(collectUnverifiedProviderSessionOwners(queued, query)).toEqual([])
  })

  it('holds an in-flight launch claim until released or expired', () => {
    const release = claimProviderSessionLaunch(OTHER, 'codex', THREAD, 1_000)
    expect(findLiveProviderSessionOwner(state(), query, 2_000)).toBe(OTHER)
    // The asking pane's own claim never blocks it.
    claimProviderSessionLaunch(ME, 'codex', THREAD, 1_000)
    release()
    expect(findLiveProviderSessionOwner(state(), query, 2_000)).toBeNull()
    claimProviderSessionLaunch(OTHER, 'codex', THREAD, 1_000)
    expect(findLiveProviderSessionOwner(state(), query, 1_000 + 60_001)).toBeNull()
  })

  it('keeps a claim while its start waits in the admission queue past the TTL', () => {
    claimProviderSessionLaunch(OTHER, 'codex', THREAD, 0)
    const settle = holdProviderSessionLaunchClaim(OTHER)
    // 51 queued starts at 3 per 10 s: this one is admitted ~170 s later.
    expect(findLiveProviderSessionOwner(state(), query, 170_000)).toBe(OTHER)
    // Once the start settles, the TTL restarts so the agent's status row can take over.
    settle(170_000)
    expect(findLiveProviderSessionOwner(state(), query, 229_000)).toBe(OTHER)
    expect(findLiveProviderSessionOwner(state(), query, 230_001)).toBeNull()
    // Settling twice, or holding a pane with no claim, changes nothing.
    settle(300_000)
    expect(holdProviderSessionLaunchClaim(ME)).toBeTypeOf('function')
    expect(findLiveProviderSessionOwner(state(), query, 300_000)).toBeNull()
  })

  it('keys pi sessions by transcript path', () => {
    const piQuery = {
      agent: 'pi',
      providerSession: { ...THREAD, transcriptPath: '/a.jsonl' },
      excludePaneKey: ME
    }
    claimProviderSessionLaunch(OTHER, 'pi', { ...THREAD, transcriptPath: '/b.jsonl' })
    expect(findLiveProviderSessionOwner(state(), piQuery)).toBeNull()
    claimProviderSessionLaunch(OTHER, 'pi', { ...THREAD, transcriptPath: '/a.jsonl' })
    expect(findLiveProviderSessionOwner(state(), piQuery)).toBe(OTHER)
  })

  it('probes unbound owners and trusts only an authoritative live answer', async () => {
    const cold = state({ agentStatusByPaneKey: { [OTHER]: status(OTHER, { state: 'working' }) } })
    const hasPty = vi.fn(async (ptyId: string) => (ptyId === 'other-pty' ? true : null))
    await expect(findLiveProviderSessionOwnerWithProbe(cold, query, hasPty)).resolves.toBe(OTHER)
    // An unbound done row also needs its agent in the foreground, not just a live PTY.
    const coldDone = state({ agentStatusByPaneKey: { [OTHER]: status(OTHER) } })
    await expect(
      findLiveProviderSessionOwnerWithProbe(coldDone, query, hasPty, async () => 'bash')
    ).resolves.toBeNull()
    await expect(
      findLiveProviderSessionOwnerWithProbe(coldDone, query, hasPty, async () => 'codex')
    ).resolves.toBe(OTHER)
    const unknown = vi.fn(async () => null)
    await expect(findLiveProviderSessionOwnerWithProbe(cold, query, unknown)).resolves.toBeNull()
    const failing = vi.fn(async () => {
      throw new Error('ipc down')
    })
    await expect(findLiveProviderSessionOwnerWithProbe(cold, query, failing)).resolves.toBeNull()
  })
})
