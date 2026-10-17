import { describe, expect, it } from 'vitest'
import {
  applyMirroredOwnerRecords,
  decideMirroredOwnerDelta,
  decideMirroredOwnerSet,
  rememberRetiredGeneration,
  type MirroredOwnerIdentity
} from './mirrored-owner-set-decision'

type Row = { id: string; pane?: string; note?: string }

const BY_ID: MirroredOwnerIdentity<Row> = { key: (row) => row.id }
// A row naming a pane supersedes that pane's anonymous row, as the ledger's identity does.
const BY_ID_SUPERSEDING_PANE: MirroredOwnerIdentity<Row> = {
  key: (row) => row.id,
  replaces: (row) => (row.pane && !row.id.startsWith('p:') ? [`p:${row.pane}`] : [])
}

const W1 = 'repo::/one'
const W2 = 'repo::/two'

function apply(
  current: Record<string, Row[]>,
  listed: Record<string, Row[]>,
  options: {
    whole?: (worktreeId: string) => boolean
    scope?: 'set' | 'delta'
    identity?: MirroredOwnerIdentity<Row>
  } = {}
) {
  const result = applyMirroredOwnerRecords({
    current: Object.entries(current).map(([worktreeId, records]) => ({ worktreeId, records })),
    listed,
    replacesWhole: options.whole ?? (() => false),
    scope: options.scope ?? 'set',
    identity: options.identity ?? BY_ID
  })
  return {
    ids: Object.fromEntries(
      [...result.recordsByWorktree].map(([worktreeId, rows]) => [worktreeId, rows.map((r) => r.id)])
    ),
    removed: result.removed,
    retained: result.retained,
    superseded: result.superseded
  }
}

// A tab record fills its pane's slot: a listed one supersedes the kept record of that pane.
const BY_ID_WITH_PANE_SLOT: MirroredOwnerIdentity<Row> = {
  key: (row) => row.id,
  slot: (row) => row.pane ?? null
}

describe('decideMirroredOwnerSet', () => {
  const current = { generation: 'g1', revision: 4, complete: true }

  it('takes a first set, then only a newer revision of the same generation', () => {
    expect(
      decideMirroredOwnerSet({
        current: undefined,
        set: { generation: 'g1', revision: 0 },
        fresh: false
      })
    ).toEqual({ apply: true, reason: 'first-set' })
    expect(
      decideMirroredOwnerSet({ current, set: { generation: 'g1', revision: 5 }, fresh: false })
    ).toEqual({ apply: true, reason: 'newer-revision' })
    expect(
      decideMirroredOwnerSet({ current, set: { generation: 'g1', revision: 4 }, fresh: true })
    ).toEqual({ apply: false, reason: 'same-revision' })
    expect(
      decideMirroredOwnerSet({ current, set: { generation: 'g1', revision: 3 }, fresh: true })
    ).toEqual({ apply: false, reason: 'older-revision' })
  })

  it('switches generation only on a fresh connection, and fences retired ones', () => {
    const next = { generation: 'g2', revision: 1 }
    expect(decideMirroredOwnerSet({ current, set: next, fresh: false })).toEqual({
      apply: false,
      reason: 'generation-change-mid-connection'
    })
    expect(decideMirroredOwnerSet({ current, set: next, fresh: true })).toEqual({
      apply: true,
      reason: 'new-generation-on-fresh-connection',
      retire: 'g1'
    })
    const retired = new Map<string, Set<string>>()
    rememberRetiredGeneration(retired, 'env', 'g1')
    expect(
      decideMirroredOwnerSet({
        current: undefined,
        set: { generation: 'g1', revision: 9 },
        fresh: true,
        retiredGenerations: retired.get('env')
      })
    ).toEqual({ apply: false, reason: 'retired-generation' })
  })

  it('names an absent set with the carrier’s reason', () => {
    expect(decideMirroredOwnerSet({ current, set: undefined, fresh: true })).toEqual({
      apply: false,
      reason: 'no-set'
    })
    expect(
      decideMirroredOwnerSet({
        current,
        set: undefined,
        fresh: true,
        absentReason: 'no-workflow-evidence'
      })
    ).toEqual({ apply: false, reason: 'no-workflow-evidence' })
  })

  it('keeps only the newest retired generations', () => {
    const retired = new Map<string, Set<string>>()
    for (let index = 0; index < 40; index += 1) {
      rememberRetiredGeneration(retired, 'env', `g${index}`)
    }
    expect(retired.get('env')?.size).toBe(32)
    expect(retired.get('env')?.has('g0')).toBe(false)
    expect(retired.get('env')?.has('g39')).toBe(true)
  })
})

describe('decideMirroredOwnerDelta', () => {
  const delta = { generation: 'g1', revision: 6, baseRevision: 4 }

  it('needs a base of the same generation at least as new as its own base', () => {
    const base = { generation: 'g1', revision: 4, complete: false }
    expect(decideMirroredOwnerDelta({ current: base, delta, requireCompleteBase: false })).toEqual({
      apply: true,
      reason: 'delta'
    })
    expect(
      decideMirroredOwnerDelta({
        current: { ...base, revision: 3 },
        delta,
        requireCompleteBase: false
      })
    ).toEqual({ apply: false, reason: 'delta-base-missing' })
    expect(
      decideMirroredOwnerDelta({ current: undefined, delta, requireCompleteBase: false })
    ).toEqual({ apply: false, reason: 'delta-without-base' })
    expect(
      decideMirroredOwnerDelta({
        current: { ...base, generation: 'g0' },
        delta,
        requireCompleteBase: false
      })
    ).toEqual({ apply: false, reason: 'delta-without-base' })
    expect(
      decideMirroredOwnerDelta({
        current: { ...base, revision: 6 },
        delta,
        requireCompleteBase: false
      })
    ).toEqual({ apply: false, reason: 'same-revision' })
  })

  it('takes a ledger delta on base 0 with no base as the owner’s first publication', () => {
    // The inventory carried a revision-0 set (nothing published yet, read as no ledger); the
    // owner's first publication is a delta on that empty base, which is the whole set.
    const first = { generation: 'g1', revision: 1, baseRevision: 0 }
    expect(
      decideMirroredOwnerDelta({ current: undefined, delta: first, requireCompleteBase: false })
    ).toEqual({ apply: true, reason: 'delta-on-empty-base' })
    expect(
      decideMirroredOwnerDelta({
        current: undefined,
        delta: first,
        retiredGenerations: new Set(['g1']),
        requireCompleteBase: false
      })
    ).toEqual({ apply: false, reason: 'retired-generation' })
    // Workflow deltas keep needing a complete base.
    expect(
      decideMirroredOwnerDelta({ current: undefined, delta: first, requireCompleteBase: true })
    ).toEqual({ apply: false, reason: 'delta-without-complete-base' })
  })

  it('keeps the workflow rule: a delta only on a complete base', () => {
    const incomplete = { generation: 'g1', revision: 4, complete: false }
    expect(
      decideMirroredOwnerDelta({ current: incomplete, delta, requireCompleteBase: true })
    ).toEqual({ apply: false, reason: 'delta-without-complete-base' })
    expect(
      decideMirroredOwnerDelta({
        current: { ...incomplete, complete: true },
        delta,
        requireCompleteBase: true
      })
    ).toEqual({ apply: true, reason: 'delta' })
  })
})

describe('applyMirroredOwnerRecords', () => {
  it('replaces a workspace whole only where the caller says so, per workspace', () => {
    const current = { [W1]: [{ id: 'a' }, { id: 'gone' }], [W2]: [{ id: 'b' }, { id: 'kept' }] }
    const result = apply(
      current,
      { [W1]: [{ id: 'a' }], [W2]: [{ id: 'b' }] },
      {
        whole: (worktreeId) => worktreeId === W1
      }
    )
    expect(result.ids).toEqual({ [W1]: ['a'], [W2]: ['kept', 'b'] })
    expect(result.removed).toEqual(['gone'])
    expect(result.retained).toEqual(['kept'])
  })

  it('empties a whole workspace the set lists nothing in, and keeps an unspoken one', () => {
    const current = { [W1]: [{ id: 'a' }], [W2]: [{ id: 'b' }] }
    const result = apply(current, {}, { whole: (worktreeId) => worktreeId === W1 })
    expect(result.ids).toEqual({ [W1]: [], [W2]: ['b'] })
    expect(result.removed).toEqual(['a'])
  })

  it('moves a record listed in another workspace instead of keeping it twice', () => {
    const result = apply({ [W1]: [{ id: 'moved' }, { id: 'stay' }] }, { [W2]: [{ id: 'moved' }] })
    expect(result.ids).toEqual({ [W1]: ['stay'], [W2]: ['moved'] })
    expect(result.retained).toEqual(['stay'])
  })

  it('leaves workspaces a delta does not name untouched', () => {
    const current = { [W1]: [{ id: 'a' }], [W2]: [{ id: 'b' }] }
    const result = apply(current, { [W1]: [] }, { scope: 'delta', whole: () => true })
    expect(result.ids).toEqual({ [W1]: [], [W2]: ['b'] })
    expect(result.removed).toEqual(['a'])
  })

  it('merges an incomplete delta workspace: updates win, omissions stay', () => {
    const current = { [W1]: [{ id: 'a', note: 'old' }, { id: 'b' }] }
    const result = apply(current, { [W1]: [{ id: 'a', note: 'new' }] }, { scope: 'delta' })
    expect(result.ids).toEqual({ [W1]: ['b', 'a'] })
    expect(result.retained).toEqual(['b'])
  })

  it('drops a kept record whose slot a listed record fills, and keeps the others (one pane, one row)', () => {
    const current = {
      [W1]: [{ id: 'c:x', pane: 'P' }, { id: 'c:y', pane: 'Q' }, { id: 'c:z' }]
    }
    const result = apply(
      current,
      { [W1]: [{ id: 'c:new', pane: 'P' }] },
      { scope: 'delta', identity: BY_ID_WITH_PANE_SLOT }
    )
    expect(result.ids).toEqual({ [W1]: ['c:y', 'c:z', 'c:new'] })
    expect(result.superseded).toEqual(['c:x'])
    expect(result.retained).toEqual(['c:y', 'c:z'])
    expect(result.removed).toEqual([])
    // A workspace taken whole removes everything omitted; nothing reads as superseded there.
    const whole = apply(
      current,
      { [W1]: [{ id: 'c:new', pane: 'P' }] },
      { whole: () => true, identity: BY_ID_WITH_PANE_SLOT }
    )
    expect(whole.ids).toEqual({ [W1]: ['c:new'] })
    expect(whole.removed).toEqual(['c:x', 'c:y', 'c:z'])
    expect(whole.superseded).toEqual([])
  })

  it('lets a pane naming its conversation supersede that pane’s anonymous row only', () => {
    const current = {
      [W1]: [
        { id: 'p:pane:1', pane: 'pane:1' },
        { id: 'p:pane:2', pane: 'pane:2' }
      ]
    }
    const result = apply(
      current,
      { [W1]: [{ id: 'c:abc', pane: 'pane:1' }] },
      {
        identity: BY_ID_SUPERSEDING_PANE
      }
    )
    expect(result.ids).toEqual({ [W1]: ['p:pane:2', 'c:abc'] })
    expect(result.retained).toEqual(['p:pane:2'])
  })
})
