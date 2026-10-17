import { describe, expect, it, vi } from 'vitest'
import {
  ClaimerStepError,
  runWakeClaims,
  type ClaimRecord,
  type WakeCandidate,
  type WakeClaimerDeps
} from './review-wake-claimer'

const ITEM: WakeCandidate = {
  slug: 'plan',
  title: 'Plan',
  revision: 2,
  decision: {
    id: '9',
    revision: 2,
    decision: 'approved',
    comment: 'go',
    edits: null,
    by: { email: 'sal@x.com', name: 'Sal' },
    at: '2026-10-05T18:00:00Z'
  },
  ownerHost: 'MacBook',
  claimableAt: '2026-10-05T18:00:00Z',
  requirements: {
    provider: 'claude',
    providerVersion: '2.1.0',
    workspace: { kind: 'folder', workRelativePath: 'Ops/X' }
  },
  copy: { sha256: 'a'.repeat(64), bytes: 10, parts: 1 }
}
const NOW = Date.parse('2026-10-05T18:01:00Z')
const HEADER = { sessionId: 'conv-1', model: 'opus', effort: 'high' } as never

function harness(items: WakeCandidate[] = [ITEM]) {
  const claims: Record<string, ClaimRecord> = {}
  const calls: string[] = []
  const deps: WakeClaimerDeps = {
    enabled: () => true,
    candidates: vi.fn(async () => ({ status: 'ok' as const, value: { items } })),
    host: async () => ({ hostId: 'host_studio', host: 'Mac Studio' }),
    windowAttached: () => true,
    providerVersion: async () => '2.1.3',
    providerHome: async () => ({ providerRoot: '/acc' }),
    chooseAccount: async () => ({ providerRoot: '/acc' }),
    latestDecision: vi.fn(async () => ITEM.decision as WakeCandidate['decision'] | 'closed' | null),
    findWorkspace: async () => ({
      kind: 'folder' as const,
      path: '/Work/Ops/X',
      workspaceId: 'w',
      projectGroupId: null
    }),
    claim: vi.fn(async () => {
      calls.push(`claim:${claims.plan?.phase}`)
      return { status: 'ok' as const, value: {} }
    }),
    release: vi.fn(async () => {
      calls.push('release')
      return true
    }),
    done: vi.fn(async () => {
      calls.push('done')
      return { status: 'ok' as const, value: {} }
    }),
    fetchCopy: vi.fn(async () => {
      calls.push('fetch')
      return { header: HEADER, bundleRoot: '/s/bundle', writtenRoot: '/s/written' }
    }),
    prepareWorkspace: vi.fn(async () => '/Work/Ops/X'),
    restoreWritten: vi.fn(async () => []),
    stage: vi.fn(async () => ({}) as never),
    launch: vi.fn(async () => {
      calls.push(`launch:${claims.plan?.phase}`)
      return { paneKey: 'tab-9:leaf-1' }
    }),
    deliver: vi.fn(async () => {
      calls.push('deliver')
    }),
    accountLabel: () => 'studio@x.com',
    readClaims: () => claims,
    writeClaim: (slug, record) => {
      if (record) {
        claims[slug] = record
      } else {
        delete claims[slug]
      }
    },
    cleanup: vi.fn(async () => {}),
    audit: vi.fn(),
    now: () => NOW
  }
  return { deps, claims, calls }
}

describe('waking another computer’s sleeping session here', () => {
  it('journals, claims, stages, resumes, marks it done, then delivers with the move', async () => {
    const { deps, claims, calls } = harness()
    await runWakeClaims(deps)
    expect(calls).toEqual(['claim:claiming', 'fetch', 'launch:launching', 'done', 'deliver'])
    expect(deps.deliver).toHaveBeenCalledWith('tab-9:leaf-1', ITEM, 'conv-1', {
      from: 'MacBook',
      to: 'Mac Studio',
      folder: '/Work/Ops/X',
      account: 'studio@x.com'
    })
    expect(claims.plan).toMatchObject({ phase: 'done', decisionId: '9', sessionId: 'conv-1' })
    expect(deps.cleanup).toHaveBeenCalledWith('plan', 2)
  })

  it('never claims what it cannot run here, before its turn, while switched off, or twice', async () => {
    for (const change of [
      { providerVersion: async () => null },
      { providerVersion: async () => '2.0.9' },
      { findWorkspace: async () => ({ refusal: 'not here' }) },
      { providerHome: async () => ({ refusal: 'no fresh account' }) },
      { enabled: () => false }
    ] as Partial<WakeClaimerDeps>[]) {
      const { deps } = harness([{ ...ITEM, slug: `plan-${Math.random()}` }])
      Object.assign(deps, change)
      await runWakeClaims(deps)
      expect(deps.claim).not.toHaveBeenCalled()
    }
    const early = harness([{ ...ITEM, claimableAt: '2026-10-05T18:05:00Z' }])
    await runWakeClaims(early.deps)
    expect(early.deps.claim).not.toHaveBeenCalled()
    const again = harness()
    again.claims.plan = { revision: 2, decisionId: '9', phase: 'failed', at: NOW - 60_000 }
    await runWakeClaims(again.deps)
    expect(again.deps.claim).not.toHaveBeenCalled()
  })

  it('skips a candidate it cannot read without blocking the next one', async () => {
    const odd = {
      ...ITEM,
      slug: 'odd',
      requirements: { ...ITEM.requirements, workspace: { kind: 'svn' } }
    }
    const { deps, calls } = harness([odd as never, ITEM])
    await runWakeClaims(deps)
    expect(calls[0]).toBe('claim:claiming')
  })

  it('does nothing new without a window, and records a lost claim', async () => {
    const closed = harness()
    closed.deps.windowAttached = () => false
    await runWakeClaims(closed.deps)
    expect(closed.deps.candidates).not.toHaveBeenCalled()
    const lost = harness()
    lost.deps.claim = vi.fn(async () => ({ status: 'refused' as const, code: 'wake_claimed' }))
    await runWakeClaims(lost.deps)
    expect(lost.deps.fetchCopy).not.toHaveBeenCalled()
    expect(lost.claims.plan).toMatchObject({ phase: 'failed', reason: 'wake_claimed' })
  })

  it('releases with the step’s word when it fails before a terminal, and retries a failed release', async () => {
    const { deps, claims, calls } = harness()
    deps.fetchCopy = vi.fn(async () => {
      throw new ClaimerStepError('network', 'download failed')
    })
    deps.release = vi.fn(async () => {
      calls.push('release')
      return false
    })
    await runWakeClaims(deps)
    expect(deps.release).toHaveBeenCalledWith('plan', expect.anything(), 'download failed')
    expect(claims.plan).toMatchObject({ phase: 'releasing', release: 'download failed' })
    deps.release = vi.fn(async () => true)
    deps.candidates = vi.fn(async () => ({ status: 'ok' as const, value: { items: [] } }))
    await runWakeClaims(deps)
    expect(deps.release).toHaveBeenCalledWith('plan', expect.anything(), 'download failed')
    expect(claims.plan!.phase).toBe('failed')
  })

  it('releases when the launch refused before a terminal, but never once one may run', async () => {
    const before = harness()
    before.deps.launch = vi.fn(async () => {
      throw new ClaimerStepError('selector_not_found', 'could not start')
    })
    await runWakeClaims(before.deps)
    expect(before.deps.release).toHaveBeenCalledWith('plan', expect.anything(), 'could not start')
    expect(before.deps.done).not.toHaveBeenCalled()
    const after = harness()
    after.deps.launch = vi.fn(async () => {
      throw new Error('the started agent did not report the same conversation')
    })
    await runWakeClaims(after.deps)
    expect(after.deps.release).not.toHaveBeenCalled()
    expect(after.deps.done).toHaveBeenCalled()
    expect(after.claims.plan!.phase).toBe('done')
  })

  it('marks a move done even when its message cannot be queued', async () => {
    const { deps, claims } = harness()
    deps.deliver = vi.fn(async () => {
      throw new Error('queue refused')
    })
    await runWakeClaims(deps)
    expect(deps.done).toHaveBeenCalled()
    expect(deps.release).not.toHaveBeenCalled()
    expect(claims.plan).toMatchObject({ phase: 'done' })
  })

  it('after a crash, releases claims that never launched and confirms any that may have', async () => {
    const { deps, claims } = harness([])
    claims.a = { revision: 1, decisionId: '1', phase: 'claiming', at: 1 }
    claims.b = { revision: 1, decisionId: '2', phase: 'moved', at: 1 }
    claims.c = { revision: 1, decisionId: '3', phase: 'launching', at: 1, sessionId: 'conv-3' }
    claims.d = {
      revision: 1,
      decisionId: '4',
      phase: 'releasing',
      at: 1,
      release: 'download failed'
    }
    await runWakeClaims(deps)
    expect(deps.release).toHaveBeenCalledTimes(2)
    expect(deps.release).toHaveBeenCalledWith('d', expect.anything(), 'download failed')
    expect(claims.a!.phase).toBe('failed')
    expect(claims.b!.phase).toBe('done')
    expect(claims.c!.phase).toBe('done')
    expect(claims.d!.phase).toBe('failed')
    expect(deps.audit).toHaveBeenCalledWith(
      { slug: 'c', revision: 1 },
      expect.stringContaining('conv-3')
    )
  })

  it('delivers the decision as it stands after the move, and nothing once it was rejected or closed', async () => {
    const changed = harness()
    const requested = { ...ITEM.decision, id: '10', decision: 'changes_requested' as const }
    changed.deps.latestDecision = vi.fn(async () => requested)
    await runWakeClaims(changed.deps)
    expect(changed.deps.deliver).toHaveBeenCalledWith(
      'tab-9:leaf-1',
      { ...ITEM, decision: requested },
      'conv-1',
      expect.anything()
    )
    const closed = harness()
    closed.deps.latestDecision = vi.fn(async () => 'closed' as const)
    await runWakeClaims(closed.deps)
    expect(closed.deps.done).toHaveBeenCalled()
    expect(closed.deps.deliver).not.toHaveBeenCalled()
    // A page that cannot be read again sends nothing either: never a possibly refused decision.
    const unread = harness()
    unread.deps.latestDecision = vi.fn(async () => null)
    await runWakeClaims(unread.deps)
    expect(unread.deps.deliver).not.toHaveBeenCalled()
    expect(unread.deps.audit).toHaveBeenCalledWith(
      ITEM,
      expect.stringContaining('could not be read')
    )
  })

  it('runs the move on the account chosen again with the copy’s model', async () => {
    const { deps } = harness()
    deps.chooseAccount = async () => ({ providerRoot: '/acc-fable' })
    await runWakeClaims(deps)
    expect(deps.stage).toHaveBeenCalledWith(expect.objectContaining({ providerRoot: '/acc-fable' }))
    expect(deps.release).not.toHaveBeenCalled()
  })

  it('releases when the account does not fit the model the copy names, and claims once per pass', async () => {
    const unfit = harness()
    unfit.deps.chooseAccount = async () => ({ refusal: 'no account has room for this model' })
    await runWakeClaims(unfit.deps)
    expect(unfit.deps.release).toHaveBeenCalledWith('plan', expect.anything(), 'cannot run here')
    const twice = harness([ITEM, { ...ITEM, slug: 'other' }])
    let writes = 0
    const write = twice.deps.writeClaim
    twice.deps.writeClaim = (slug, record) => {
      writes += 1
      if (writes === 2) {
        throw new Error('disk full')
      }
      write(slug, record)
    }
    await runWakeClaims(twice.deps)
    expect(twice.deps.claim).toHaveBeenCalledTimes(1)
  })

  it('never claims again for a decision this computer cannot run, but retries a passing failure', async () => {
    const final = harness()
    final.deps.chooseAccount = async () => ({ refusal: 'no account has room for this model' })
    await runWakeClaims(final.deps)
    expect(final.claims.plan).toMatchObject({ phase: 'failed', final: true })
    final.claims.plan!.at = NOW - 3_600_000
    await runWakeClaims(final.deps)
    expect(final.deps.claim).toHaveBeenCalledTimes(1)
    const passing = harness()
    passing.deps.prepareWorkspace = vi.fn(async () => {
      throw new Error('git timed out')
    })
    await runWakeClaims(passing.deps)
    expect(passing.claims.plan).toMatchObject({ phase: 'failed', release: 'cannot run here' })
    expect(passing.claims.plan).not.toHaveProperty('final')
    passing.claims.plan!.at = NOW - 3_600_000
    await runWakeClaims(passing.deps)
    expect(passing.deps.claim).toHaveBeenCalledTimes(2)
  })

  it('never claims again for a decision whose copy could not be verified', async () => {
    const { deps, claims } = harness()
    claims.plan = {
      revision: 2,
      decisionId: '9',
      phase: 'failed',
      release: 'could not verify',
      at: NOW - 3_600_000
    }
    await runWakeClaims(deps)
    expect(deps.claim).not.toHaveBeenCalled()
  })
})
