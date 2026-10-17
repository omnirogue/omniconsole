import { describe, expect, it } from 'vitest'
import { normalizeSessionChain } from './session-chain-types'
import { openHumanAttention } from './session-human-attention'
import { sealSessionRunCompletion } from './session-run-completion'
import {
  normalizeSessionOutcomeSet,
  recordSessionOutcomeEvidence,
  reviseSessionOutcomeSet,
  runnableSessionOutcomeActions,
  sessionOutcomeProgress
} from './session-outcome-state'
import {
  sessionOutcomeActionKey,
  sessionOutcomeConditionKey,
  type SessionOutcomeDefinition,
  type SessionOutcomeEvidence,
  type SessionOutcomeSet
} from './session-outcome-types'

const owner = { owner: 'execution-host', hostId: 'local', epoch: 'host1', state: 'owned' } as const
const definition = (id: string): SessionOutcomeDefinition => ({
  id,
  title: id,
  finish: 'complete',
  dependsOn: [],
  conditions: [{ id: 'file', kind: 'file', target: `/output/${id}`, version: 'a'.repeat(64) }],
  actions: []
})
const commit = (outcomes = [definition('one'), definition('two')]): SessionOutcomeSet =>
  reviseSessionOutcomeSet(undefined, { expectedRevision: 0, outcomes, source: 'user' }, owner, 1)
function evidence(set: SessionOutcomeSet, id: string): SessionOutcomeEvidence {
  const outcome = set.outcomes.find((entry) => entry.id === id)!,
    condition = outcome.conditions[0]!
  return {
    id: `receipt_${id}`,
    outcomeId: id,
    outcomeRevision: outcome.revision,
    conditionId: condition.id,
    conditionKey: sessionOutcomeConditionKey(condition),
    kind: condition.kind,
    target: condition.target,
    version: condition.version,
    receipt: `sha256:${condition.version}`,
    verifiedAt: 2,
    verifier: 'execution-host'
  }
}
const satisfy = (set: SessionOutcomeSet, id: string): SessionOutcomeSet =>
  recordSessionOutcomeEvidence(set, evidence(set, id))

describe('committed session outcome sets', () => {
  it('requires every outcome, retaining a partial completion across restart', () => {
    const partial = satisfy(commit(), 'one')
    const restored = normalizeSessionOutcomeSet(JSON.parse(JSON.stringify(partial)))!
    expect(sessionOutcomeProgress(restored)).toMatchObject({
      lifecycle: 'waiting',
      satisfied: 1,
      total: 2
    })
    expect(sessionOutcomeProgress(satisfy(restored, 'two')).lifecycle).toBe('complete')
  })
  it('rejects cross-outcome and stale evidence and deduplicates exact callbacks', () => {
    const set = commit(),
      receipt = evidence(set, 'one')
    expect(() => recordSessionOutcomeEvidence(set, { ...receipt, outcomeId: 'two' })).toThrow(
      'stale'
    )
    expect(() => recordSessionOutcomeEvidence(set, { ...receipt, outcomeRevision: 2 })).toThrow(
      'stale'
    )
    const next = recordSessionOutcomeEvidence(set, receipt)
    expect(recordSessionOutcomeEvidence(next, receipt)).toBe(next)
    expect(() => recordSessionOutcomeEvidence(next, { ...receipt, receipt: 'different' })).toThrow(
      'conflict'
    )
  })
  it('makes concurrent whole-set edits conflict and preserves the previous object', () => {
    const original = commit(),
      snapshot = structuredClone(original)
    const edited = reviseSessionOutcomeSet(
      original,
      {
        expectedRevision: 1,
        outcomes: [definition('one'), { ...definition('two'), title: 'Updated title' }],
        source: 'user'
      },
      owner,
      3
    )
    expect(() =>
      reviseSessionOutcomeSet(
        edited,
        { expectedRevision: 1, outcomes: [definition('one')], source: 'user' },
        owner,
        4
      )
    ).toThrow('conflict')
    expect(original).toEqual(snapshot)
  })
  it('invalidates only evidence for a changed version and reopens completed work when adding an obligation', () => {
    const complete = satisfy(satisfy(commit(), 'one'), 'two')
    const edited = reviseSessionOutcomeSet(
      complete,
      {
        expectedRevision: 1,
        outcomes: [
          definition('one'),
          {
            ...definition('two'),
            conditions: [{ ...definition('two').conditions[0]!, version: 'b'.repeat(64) }]
          },
          definition('three')
        ],
        source: 'user'
      },
      owner,
      3
    )
    expect(edited.outcomes.map((outcome) => outcome.status)).toEqual([
      'satisfied',
      'pending',
      'pending'
    ])
    expect(sessionOutcomeProgress(edited)).toMatchObject({
      lifecycle: 'waiting',
      satisfied: 1,
      total: 3
    })
  })
  it('keeps inferred file proof historical when the requested result changes', () => {
    const unpinned = {
      ...definition('one'),
      conditions: [{ id: 'file', kind: 'file' as const, target: '/output/one' }]
    }
    let set = commit([unpinned])
    const outcome = set.outcomes[0]!,
      condition = outcome.conditions[0]!
    set = recordSessionOutcomeEvidence(set, {
      id: 'receipt_inferred',
      outcomeId: outcome.id,
      outcomeRevision: outcome.revision,
      conditionId: condition.id,
      conditionKey: sessionOutcomeConditionKey(condition),
      kind: condition.kind,
      target: condition.target,
      version: 'b'.repeat(64),
      receipt: `sha256:${'b'.repeat(64)}`,
      verifiedAt: 2,
      verifier: 'execution-host'
    })
    expect(set.outcomes[0]?.status).toBe('satisfied')
    const revised = reviseSessionOutcomeSet(
      set,
      {
        expectedRevision: 1,
        outcomes: [{ ...unpinned, title: 'Revised result' }],
        source: 'user'
      },
      owner,
      3
    )
    expect(revised.outcomes[0]).toMatchObject({
      revision: 2,
      status: 'pending',
      evidence: []
    })
    expect(revised.evidenceHistory).toEqual(set.outcomes[0]!.evidence)
  })
  it('requires explicit removal reasons, audits removal and prevents AI dropping obligations', () => {
    const set = commit()
    expect(() =>
      reviseSessionOutcomeSet(
        set,
        { expectedRevision: 1, outcomes: [definition('one')], source: 'user' },
        owner,
        3
      )
    ).toThrow('scope-change')
    expect(() =>
      reviseSessionOutcomeSet(
        set,
        {
          expectedRevision: 1,
          outcomes: [definition('one')],
          removals: [{ outcomeId: 'two', reason: 'Changed scope' }],
          source: 'ai'
        },
        owner,
        3
      )
    ).toThrow('AI cannot')
    const next = reviseSessionOutcomeSet(
      set,
      {
        expectedRevision: 1,
        outcomes: [definition('one')],
        removals: [{ outcomeId: 'two', reason: 'Changed scope' }],
        source: 'user'
      },
      owner,
      3
    )
    expect(next.removals).toEqual([
      { outcomeId: 'two', revision: 2, reason: 'Changed scope', removedAt: 3 }
    ])
  })
  it('rejects cycles, missing dependencies and custom instructions without executable actions', () => {
    expect(() => commit([{ ...definition('one'), dependsOn: ['one'] }])).toThrow('cycle')
    expect(() => commit([{ ...definition('one'), dependsOn: ['missing'] }])).toThrow(
      'does not exist'
    )
    expect(() => commit([{ ...definition('one'), instructions: 'Publish the release' }])).toThrow(
      'executable'
    )
    expect(() =>
      commit([
        {
          ...definition('one'),
          instructions: 'Publish the release',
          stepIds: ['writer-step']
        }
      ])
    ).not.toThrow()
  })
  it('continues independent authorized actions while one outcome is blocked and gates dependents', () => {
    const action = {
      id: 'build',
      instruction: 'Build output',
      conditionIds: ['file'],
      authority: 'existing-user-authority',
      agent: 'codex'
    } as const
    const set = commit(
      ['one', 'two', 'three'].map((id) => ({
        ...definition(id),
        dependsOn: id === 'three' ? ['one'] : [],
        actions: [{ ...action, conditionIds: ['file'] }]
      }))
    )
    set.outcomes[0]!.status = 'blocked'
    set.outcomes[0]!.blockedReason = 'Missing access'
    expect(runnableSessionOutcomeActions(set)).toEqual([{ outcomeId: 'two', actionId: 'build' }])
    // The reason is a diagnostic: with no request to a person, a blocked outcome is never needs-you,
    // and the independent work beside it keeps the run active.
    expect(sessionOutcomeProgress(set, { now: 10 })).toMatchObject({
      lifecycle: 'waiting',
      phase: 'active',
      attention: [],
      reasons: ['one: Missing access']
    })
  })
  it('never repeats a completed external action, and evidence alone cannot skip an action', () => {
    const action = {
      id: 'send',
      instruction: 'Deliver file',
      conditionIds: ['file'],
      authority: 'existing-user-authority' as const,
      agent: 'codex' as const
    }
    let set = commit([{ ...definition('one'), actions: [action] }])
    set = satisfy(set, 'one')
    expect(sessionOutcomeProgress(set).lifecycle).toBe('waiting')
    set.attempts.push({
      id: 'attempt',
      outcomeId: 'one',
      outcomeRevision: 1,
      actionId: 'send',
      actionKey: sessionOutcomeActionKey(action),
      state: 'completed',
      startedAt: 1,
      updatedAt: 2,
      dispatchId: 'dispatch'
    })
    set = normalizeSessionOutcomeSet(set)!
    expect(sessionOutcomeProgress(set).lifecycle).toBe('complete')
    expect(runnableSessionOutcomeActions(set)).toEqual([])
    expect(() =>
      reviseSessionOutcomeSet(
        set,
        {
          expectedRevision: 1,
          outcomes: [{ ...definition('one'), actions: [{ ...action, instruction: 'Send again' }] }],
          source: 'user'
        },
        owner,
        3
      )
    ).toThrow('completed action')
  })
  it('fences in-flight edits/removals instead of replaying uncertain external effects', () => {
    const set = commit()
    set.attempts.push({
      id: 'attempt',
      outcomeId: 'one',
      outcomeRevision: 1,
      actionId: 'send',
      actionKey: 'send',
      state: 'unverifiable',
      startedAt: 1,
      updatedAt: 2
    })
    expect(() =>
      reviseSessionOutcomeSet(
        set,
        {
          expectedRevision: 1,
          outcomes: [{ ...definition('one'), title: 'changed' }, definition('two')],
          source: 'user'
        },
        owner,
        3
      )
    ).toThrow('in-flight')
    expect(() =>
      reviseSessionOutcomeSet(
        set,
        {
          expectedRevision: 1,
          outcomes: [definition('two')],
          removals: [{ outcomeId: 'one', reason: 'Remove' }],
          source: 'user'
        },
        owner,
        3
      )
    ).toThrow('in-flight')
  })
  it('preserves legacy chains and refuses an unknown outcome schema rather than dropping obligations', () => {
    const chain = {
      id: 'chain',
      workspacePath: '/workspace',
      worktreeId: 'work',
      sourcePaneKey: 'pane',
      sourceRowKey: 'row',
      end: 'done',
      steps: []
    }
    expect(normalizeSessionChain(chain)?.outcomeSet).toBeUndefined()
    expect(
      normalizeSessionChain({ ...chain, outcomeSet: { ...commit(), schemaVersion: 2 } })
    ).toBeNull()
    expect(
      normalizeSessionChain({ ...chain, outcomeSet: commit() })?.outcomeSet?.outcomes
    ).toHaveLength(2)
  })
})

it('keeps cached complete evidence from asserting completion while its execution owner is unverifiable', () => {
  const complete = satisfy(satisfy(commit(), 'one'), 'two')
  const unavailable: SessionOutcomeSet = {
    ...complete,
    continuation: { ...complete.continuation, state: 'unverifiable' }
  }
  // Lost contact asserts nothing and asks nobody: the run waits for its host, it does not need you.
  expect(sessionOutcomeProgress(unavailable)).toMatchObject({
    lifecycle: 'waiting',
    phase: 'waiting',
    satisfied: 2,
    total: 2,
    attention: [],
    reasons: ['Execution host continuation is unverifiable.']
  })
  expect(sessionOutcomeProgress(complete).lifecycle).toBe('complete')
})

it('persists session disposition through outcome edits and host restoration', () => {
  const first = reviseSessionOutcomeSet(
    undefined,
    {
      expectedRevision: 0,
      outcomes: [definition('one')],
      source: 'user',
      sessionFinish: { action: 'save' }
    },
    owner,
    1
  )
  const edited = reviseSessionOutcomeSet(
    first,
    {
      expectedRevision: 1,
      outcomes: [definition('one')],
      source: 'ai'
    },
    owner,
    2
  )
  expect(normalizeSessionOutcomeSet(JSON.parse(JSON.stringify(edited)))?.sessionFinish).toEqual({
    action: 'save'
  })
  expect(sessionOutcomeProgress(edited).lifecycle).toBe('waiting')
})

describe('the coarse progress older callers read', () => {
  const blocked = (): SessionOutcomeSet => {
    const set = commit([definition('one')])
    return {
      ...set,
      outcomes: [
        {
          ...set.outcomes[0]!,
          status: 'blocked',
          blockedReason: 'No activity was observed for 180s.',
          block: { class: 'failed', code: 'worker-stalled', since: 5 }
        }
      ]
    }
  }

  it('carries the phase and the requests beside the fields it always had', () => {
    const progress = sessionOutcomeProgress(blocked(), { now: 10 })
    expect(Object.keys(progress).sort()).toEqual([
      'attention',
      'failure',
      'lifecycle',
      'phase',
      'reasons',
      'satisfied',
      'total'
    ])
    expect(progress).toEqual({
      lifecycle: 'waiting',
      phase: 'failed',
      satisfied: 0,
      total: 1,
      reasons: ['one: No activity was observed for 180s.'],
      attention: [],
      failure: {
        outcomeId: blocked().outcomes[0]!.id,
        code: 'worker-stalled',
        reason: 'No activity was observed for 180s.'
      }
    })
  })

  it('says needs-you only for an open request addressed to the owner', () => {
    const opened = openHumanAttention(
      blocked(),
      {
        kind: 'credential',
        scope: { outcomeId: 'one', outcomeRevision: 1 },
        ask: 'Sign Codex in again.',
        why: "Codex's provider rejected its sign-in, and only you hold those credentials.",
        recipient: { type: 'owner' },
        action: { kind: 'sign-in', label: 'Sign in' },
        source: { type: 'provider-authentication', ref: 'Codex' }
      },
      6
    )
    const progress = sessionOutcomeProgress(opened.set, { now: 10 })
    expect(progress).toMatchObject({ lifecycle: 'needs-you', phase: 'needs-you' })
    expect(progress.attention.map((entry) => entry.id)).toEqual([opened.id])
    // Under a newer plan version the request is about a strategy that no longer exists.
    expect(sessionOutcomeProgress(opened.set, { now: 10, planVersion: 2 })).toMatchObject({
      lifecycle: 'waiting',
      phase: 'failed',
      attention: []
    })
  })
})

describe('a sealed set', () => {
  const action = {
    id: 'send',
    instruction: 'Deliver file',
    conditionIds: ['file'],
    authority: 'existing-user-authority' as const,
    agent: 'codex' as const
  }
  const sealed = (): SessionOutcomeSet =>
    sealSessionRunCompletion(satisfy(commit([definition('one')]), 'one'), {
      now: 5,
      operationId: 'op_seal'
    })

  it('round-trips its seal, disposition, requests and block classes through persistence', () => {
    const set = sealed()
    const restored = normalizeSessionOutcomeSet(JSON.parse(JSON.stringify(set)))!
    expect(restored).toEqual(set)
    expect(restored.completion).toEqual({
      at: 5,
      outcomes: [{ id: 'one', revision: 1 }],
      evidenceIds: ['receipt_one']
    })
    expect(restored.disposition).toMatchObject({ intent: 'completed', state: 'applied' })
    const blocked: SessionOutcomeSet = {
      ...commit([definition('one')]),
      attention: []
    }
    blocked.outcomes[0] = {
      ...blocked.outcomes[0]!,
      status: 'blocked',
      blockedReason: 'Waiting for the merge.',
      block: { class: 'waiting', code: 'evidence-poll', since: 5, wake: 'pull request merge' }
    }
    expect(normalizeSessionOutcomeSet(JSON.parse(JSON.stringify(blocked)))).toEqual(blocked)
  })

  it('drops a block from an outcome that is no longer blocked', () => {
    const set = commit([definition('one')])
    set.outcomes[0] = {
      ...set.outcomes[0]!,
      block: { class: 'failed', code: 'worker-stalled', since: 5 }
    }
    expect(normalizeSessionOutcomeSet(set)?.outcomes[0]?.block).toBeUndefined()
  })

  it('is read as it was proven: drift does not demote it, and nothing is left to launch', () => {
    const set = sealed()
    const drifted: SessionOutcomeSet = {
      ...set,
      outcomes: [{ ...set.outcomes[0]!, evidence: [], actions: [action] }]
    }
    expect(
      normalizeSessionOutcomeSet(JSON.parse(JSON.stringify(drifted)))?.outcomes[0]?.status
    ).toBe('satisfied')
    expect(sessionOutcomeProgress(drifted)).toMatchObject({
      lifecycle: 'complete',
      phase: 'completed',
      satisfied: 1,
      total: 1,
      reasons: []
    })
    expect(
      runnableSessionOutcomeActions({
        ...drifted,
        outcomes: [{ ...drifted.outcomes[0]!, status: 'pending' }]
      })
    ).toEqual([])
  })

  it('records no further evidence: a later receipt is about the world since', () => {
    const set = sealed()
    const late = { ...evidence(set, 'one'), id: 'receipt_late', verifiedAt: 99 }
    expect(recordSessionOutcomeEvidence(set, late)).toBe(set)
    // A receipt for another outcome or revision is still refused, sealed or not.
    expect(() => recordSessionOutcomeEvidence(set, { ...late, outcomeRevision: 2 })).toThrow(
      'stale'
    )
  })
})
