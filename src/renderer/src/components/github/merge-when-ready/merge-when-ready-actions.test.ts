import { describe, expect, it } from 'vitest'
import type { MergeWhenReadyPullRequestFacts } from '../../../../../shared/github/merge-when-ready-facts'
import {
  armMergeWhenReady,
  disarmMergeWhenReady,
  planMergeAll,
  readMergeWhenReadyFacts,
  runMergeAll,
  type MergeWhenReadyClient
} from './merge-when-ready-actions'

const BOX = '- [ ] **Merge when ready** (Sal or Uma: tick to merge)'
const TICKED = '- [x] **Merge when ready** (Sal or Uma: tick to merge)'

function facts(
  number: number,
  overrides: Partial<MergeWhenReadyPullRequestFacts> = {}
): MergeWhenReadyPullRequestFacts {
  return {
    number,
    title: `PR ${number}`,
    body: `${BOX}\n\nBody ${number}`,
    state: 'open',
    isDraft: false,
    url: `https://github.com/acme/omni/pull/${number}`,
    author: 'opener',
    createdAt: '2026-10-12T09:00:00Z',
    baseRefName: 'prod-omnirogue',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    labels: [],
    checks: [],
    labelEvents: [],
    titleEvents: [],
    olderEventsOmitted: false,
    ...overrides
  }
}

/** A GitHub stand-in that applies writes to its PRs and records every call. */
function fakeClient(
  prs: MergeWhenReadyPullRequestFacts[],
  options: {
    failUpdate?: Set<number>
    landThenFail?: Set<number>
    failLabels?: boolean
    dropWrites?: Set<number>
    beforeRead?: (read: number) => void
  } = {}
) {
  const store = new Map(prs.map((pr) => [pr.number, { ...pr }]))
  const calls: string[] = []
  let reads = 0
  const client: MergeWhenReadyClient = {
    readFacts: async (numbers) => {
      reads += 1
      options.beforeRead?.(reads)
      calls.push(`read ${numbers.join(',')}`)
      return {
        pullRequests: numbers.flatMap((n) => {
          const pr = store.get(n)
          return pr ? [{ ...pr }] : []
        }),
        missing: numbers.filter((n) => !store.has(n))
      }
    },
    updatePullRequest: async (number, updates) => {
      calls.push(`update ${number} ${JSON.stringify(updates)}`)
      if (options.failUpdate?.has(number)) {
        throw new Error('GitHub said no')
      }
      const pr = store.get(number)
      if (pr && !options.dropWrites?.has(number)) {
        store.set(number, { ...pr, ...updates })
      }
      if (options.landThenFail?.has(number)) {
        throw new Error('timed out')
      }
    },
    removeLabels: async (number, labels) => {
      calls.push(`unlabel ${number} ${labels.join(',')}`)
      if (options.failLabels) {
        throw new Error('label gone')
      }
      const pr = store.get(number)
      if (pr) {
        store.set(number, { ...pr, labels: pr.labels.filter((l) => !labels.includes(l)) })
      }
    }
  }
  return { client, calls, store }
}

describe('armMergeWhenReady', () => {
  it('ticks the box of a ready PR and confirms it by reading back', async () => {
    const { client, calls, store } = fakeClient([facts(7)])

    await expect(armMergeWhenReady(client, 7, { liftHolds: [] })).resolves.toEqual({
      kind: 'armed',
      warnings: []
    })
    expect(store.get(7)?.body).toBe(`${TICKED}\n\nBody 7`)
    expect(calls).toEqual([
      'read 7',
      `update 7 ${JSON.stringify({ body: `${TICKED}\n\nBody 7` })}`,
      'read 7'
    ])
  })

  it('stops at a hold until the person agrees to lift it', async () => {
    const held = facts(8, {
      title: 'Refunds - do not merge yet',
      labels: ['do-not-merge'],
      labelEvents: [{ label: 'do-not-merge', login: 'uma', at: '2026-10-12T11:00:00Z' }]
    })
    const { client, calls } = fakeClient([held])

    await expect(armMergeWhenReady(client, 8, { liftHolds: [] })).resolves.toEqual({
      kind: 'held',
      holds: [
        { kind: 'label', label: 'do-not-merge', by: 'uma', at: '2026-10-12T11:00:00Z' },
        { kind: 'title', phrase: 'do not merge yet', by: 'opener', at: '2026-10-12T09:00:00Z' }
      ]
    })
    expect(calls).toEqual(['read 8'])
  })

  it('lifts title and label holds with the tick when asked to', async () => {
    const { client, calls, store } = fakeClient([
      facts(9, { title: 'Refunds - do not merge yet', labels: ['do-not-merge', 'preview-off'] })
    ])

    await expect(
      armMergeWhenReady(client, 9, {
        liftHolds: [
          { kind: 'label', label: 'do-not-merge' },
          { kind: 'title', phrase: 'do not merge yet' }
        ]
      })
    ).resolves.toEqual({
      kind: 'armed',
      warnings: []
    })
    expect(calls[1]).toBe(
      `update 9 ${JSON.stringify({ body: `${TICKED}\n\nBody 9`, title: 'Refunds' })}`
    )
    expect(calls[2]).toBe('unlabel 9 do-not-merge')
    expect(store.get(9)?.labels).toEqual(['preview-off'])
  })

  it('reports a label it could not remove without failing the arm', async () => {
    const { client } = fakeClient([facts(10, { labels: ['do-not-merge'] })], { failLabels: true })

    await expect(
      armMergeWhenReady(client, 10, { liftHolds: [{ kind: 'label', label: 'do-not-merge' }] })
    ).resolves.toEqual({
      kind: 'armed',
      warnings: [{ kind: 'labels-kept', labels: ['do-not-merge'], message: 'label gone' }]
    })
  })

  it('keeps a title that would be empty without its marker', async () => {
    const { client, calls } = fakeClient([facts(11, { title: 'DO NOT MERGE' })])

    await expect(
      armMergeWhenReady(client, 11, { liftHolds: [{ kind: 'title', phrase: 'DO NOT MERGE' }] })
    ).resolves.toEqual({
      kind: 'armed',
      warnings: [{ kind: 'title-kept', phrase: 'DO NOT MERGE' }]
    })
    expect(calls[1]).toBe(`update 11 ${JSON.stringify({ body: `${TICKED}\n\nBody 11` })}`)
  })

  it('writes nothing to PRs it must not arm', async () => {
    const { client, calls } = fakeClient([
      facts(1, { body: TICKED }),
      facts(2, { body: 'no box here' }),
      facts(3, { state: 'merged' })
    ])

    await expect(armMergeWhenReady(client, 1, { liftHolds: [] })).resolves.toEqual({
      kind: 'already-armed'
    })
    await expect(armMergeWhenReady(client, 2, { liftHolds: [] })).resolves.toEqual({
      kind: 'no-box'
    })
    await expect(armMergeWhenReady(client, 3, { liftHolds: [] })).resolves.toEqual({
      kind: 'not-open'
    })
    await expect(armMergeWhenReady(client, 4, { liftHolds: [] })).resolves.toEqual({
      kind: 'missing'
    })
    expect(calls.filter((call) => !call.startsWith('read'))).toEqual([])
  })

  it('does not claim success when the read-back lacks the tick', async () => {
    const { client } = fakeClient([facts(12)], { dropWrites: new Set([12]) })

    await expect(armMergeWhenReady(client, 12, { liftHolds: [] })).resolves.toEqual({
      kind: 'unverified'
    })
  })

  it('stops at a hold set after the person agreed to lift the ones they saw', async () => {
    const { client, calls } = fakeClient([
      facts(14, { title: 'Refunds [DO NOT MERGE YET]', labels: ['do-not-merge'] })
    ])

    const outcome = await armMergeWhenReady(client, 14, {
      liftHolds: [{ kind: 'label', label: 'do-not-merge' }]
    })

    expect(outcome.kind).toBe('held')
    expect(calls).toEqual(['read 14'])
  })

  it('counts a write that timed out after landing as armed', async () => {
    const { client } = fakeClient([facts(15)], { landThenFail: new Set([15]) })

    await expect(armMergeWhenReady(client, 15, { liftHolds: [] })).resolves.toEqual({
      kind: 'armed',
      warnings: []
    })
  })

  it('lets a failed write surface as an error', async () => {
    const { client } = fakeClient([facts(13)], { failUpdate: new Set([13]) })

    await expect(armMergeWhenReady(client, 13, { liftHolds: [] })).rejects.toThrow('GitHub said no')
  })
})

describe('disarmMergeWhenReady', () => {
  it('unticks an armed PR and confirms it', async () => {
    const { client, store } = fakeClient([facts(20, { body: `${TICKED}\n\nBody 20` })])

    await expect(disarmMergeWhenReady(client, 20)).resolves.toEqual({ kind: 'disarmed' })
    expect(store.get(20)?.body).toBe(`${BOX}\n\nBody 20`)
  })

  it('counts an untick that timed out after landing as done', async () => {
    const { client } = fakeClient([facts(24, { body: `${TICKED}\n\nBody 24` })], {
      landThenFail: new Set([24])
    })

    await expect(disarmMergeWhenReady(client, 24)).resolves.toEqual({ kind: 'disarmed' })
  })

  it('leaves unticked, box-less and closed PRs alone', async () => {
    const { client, calls } = fakeClient([
      facts(21),
      facts(22, { body: 'no box' }),
      facts(23, { state: 'closed', body: TICKED })
    ])

    await expect(disarmMergeWhenReady(client, 21)).resolves.toEqual({ kind: 'already-disarmed' })
    await expect(disarmMergeWhenReady(client, 22)).resolves.toEqual({ kind: 'no-box' })
    await expect(disarmMergeWhenReady(client, 23)).resolves.toEqual({ kind: 'not-open' })
    expect(calls.filter((call) => !call.startsWith('read'))).toEqual([])
  })

  it('reports a PR the job merged before the untick landed', async () => {
    const { client, store } = fakeClient([facts(24, { body: TICKED })], {
      beforeRead: (read) => {
        if (read === 2) {
          store.set(24, { ...store.get(24)!, state: 'merged' })
        }
      }
    })

    await expect(disarmMergeWhenReady(client, 24)).resolves.toEqual({ kind: 'not-open' })
  })
})

describe('readMergeWhenReadyFacts', () => {
  it('reads in batches of 50 and collects missing PRs', async () => {
    const numbers = Array.from({ length: 120 }, (_, i) => i + 1)
    const { client, calls } = fakeClient(numbers.slice(0, 119).map((n) => facts(n)))

    const read = await readMergeWhenReadyFacts(client, [...numbers, 1])

    expect(calls.map((call) => call.split(' ')[1].split(',').length)).toEqual([50, 50, 20])
    expect(read.byNumber.size).toBe(119)
    expect(read.missing).toEqual([120])
  })
})

describe('planMergeAll', () => {
  it('arms ready PRs and says why it skips the rest', () => {
    const held = facts(2, { labels: ['do-not-merge'] })
    const read = {
      byNumber: new Map([
        [1, facts(1)],
        [2, held],
        [3, facts(3, { body: TICKED })],
        [4, facts(4, { body: 'no box' })],
        [5, facts(5, { state: 'closed' })]
      ]),
      missing: [6]
    }

    const plan = planMergeAll([1, 2, 3, 4, 5, 6], read)

    expect(plan.arm.map((pr) => pr.number)).toEqual([1])
    expect(plan.skip).toEqual([
      {
        number: 2,
        title: 'PR 2',
        reason: {
          kind: 'held',
          holds: [{ kind: 'label', label: 'do-not-merge', by: null, at: null }]
        }
      },
      { number: 3, title: 'PR 3', reason: { kind: 'armed' } },
      { number: 4, title: 'PR 4', reason: { kind: 'no-box' } },
      { number: 5, title: 'PR 5', reason: { kind: 'not-open' } },
      { number: 6, title: '', reason: { kind: 'missing' } }
    ])
  })
})

describe('runMergeAll', () => {
  it('re-reads before writing, so a hold added after the preview still wins', async () => {
    const { client, store, calls } = fakeClient([facts(1), facts(2), facts(3)])
    store.set(2, { ...store.get(2)!, labels: ['do-not-merge'] })

    const run = await runMergeAll(client, [1, 2, 3])

    expect(run.armed).toEqual([1, 3])
    expect(run.plan.skip.map((skip) => skip.number)).toEqual([2])
    expect(calls.filter((call) => call.startsWith('update')).map((c) => c.split(' ')[1])).toEqual([
      '1',
      '3'
    ])
    expect(calls.at(-1)).toBe('read 1,3')
  })

  it('reads back failed writes and counts the ones that landed as armed', async () => {
    const { client, calls } = fakeClient([facts(1), facts(2), facts(3)], {
      landThenFail: new Set([2]),
      failUpdate: new Set([3])
    })

    const run = await runMergeAll(client, [1, 2, 3])

    expect(run).toMatchObject({
      armed: [1, 2],
      failed: [{ number: 3, message: 'GitHub said no' }],
      unverified: []
    })
    expect(calls.at(-1)).toBe('read 1,2,3')
  })

  it('separates failed writes from writes it could not confirm', async () => {
    const progress: string[] = []
    const { client } = fakeClient([facts(1), facts(2), facts(3)], {
      failUpdate: new Set([2]),
      dropWrites: new Set([3])
    })

    const run = await runMergeAll(client, [1, 2, 3], (done, total) =>
      progress.push(`${done}/${total}`)
    )

    expect(run).toMatchObject({
      armed: [1],
      failed: [{ number: 2, title: 'PR 2', message: 'GitHub said no' }],
      unverified: [3]
    })
    expect(progress).toEqual(['1/3', '2/3', '3/3'])
  })
})
