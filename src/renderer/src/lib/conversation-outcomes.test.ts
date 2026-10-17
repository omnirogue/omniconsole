import { describe, expect, it } from 'vitest'
import { normalizeSessionChain, type SessionChain } from '../../../shared/session-chain-types'
import { openHumanAttention } from '../../../shared/session-human-attention'
import {
  reviseSessionOutcomeSet,
  recordSessionOutcomeEvidence
} from '../../../shared/session-outcome-state'
import {
  sessionOutcomeConditionKey,
  type SessionOutcomeSet
} from '../../../shared/session-outcome-types'
import { classifyConversation } from './conversation-retention'
import { sessionRunRowState } from './session-run-row-state'
import { sealSessionRunCompletion } from '../../../shared/session-run-completion'

function outcomes(): SessionOutcomeSet {
  return reviseSessionOutcomeSet(
    undefined,
    {
      expectedRevision: 0,
      source: 'user',
      outcomes: ['delivery', 'implementation'].map((id) => ({
        id,
        title: id,
        finish: 'complete',
        dependsOn: [],
        actions: [],
        conditions: [{ id: 'file', kind: 'file', target: `/output/${id}.txt` }]
      }))
    },
    {
      owner: 'execution-host',
      hostId: 'local',
      epoch: 'epoch',
      state: 'owned',
      sourceReady: true,
      sourceVersion: 'turn1'
    },
    100
  )
}
function verify(set: SessionOutcomeSet, index: number): SessionOutcomeSet {
  const outcome = set.outcomes[index]!
  const condition = outcome.conditions[0]!
  return recordSessionOutcomeEvidence(set, {
    id: `evidence_${index}`,
    outcomeId: outcome.id,
    conditionId: condition.id,
    outcomeRevision: outcome.revision,
    conditionKey: sessionOutcomeConditionKey(condition),
    kind: condition.kind,
    target: condition.target,
    receipt: 'host-observed-file-sha',
    verifiedAt: 101,
    verifier: 'execution-host'
  })
}
function chain(set: SessionOutcomeSet): SessionChain {
  const value = normalizeSessionChain({
    id: 'chain',
    workspacePath: '/work',
    worktreeId: 'folder:work',
    sourcePaneKey: 'tab:leaf',
    sourceRowKey: 'row',
    steps: [],
    state: set.completion ? 'done' : 'waiting',
    outcomeSet: set
  })
  if (!value) {
    throw new Error('Invalid test outcome fixture')
  }
  return value
}
function classify(set: SessionOutcomeSet, extra = {}) {
  return classifyConversation({
    now: 1_000_000_000,
    state: 'done',
    stateChangedAt: 1,
    waitingUntil: null,
    attention: false,
    unavailable: false,
    chain: chain(set),
    ...extra
  })
}

/** The group the run's own row reading gives; the sidebar must agree with it. */
function rowGroup(set: SessionOutcomeSet) {
  return sessionRunRowState(chain(set), { now: 1_000_000_000 }).group
}

describe('committed outcomes in the real conversation classifier', () => {
  it('ignores pane exit and retention age while even one obligation remains', () => {
    const set = verify(outcomes(), 0)
    // Outstanding obligations without an executing attempt remain Waiting.
    expect(classify(set)).toEqual({ group: 'waiting', completed: null })
    expect(classify(set, { state: null, unavailable: true })).toEqual({
      group: 'waiting',
      completed: null
    })
    expect(rowGroup(set)).toBe('waiting')
  })
  it('reads a blocked reason as a diagnostic, and only an open owner request as Needs you', () => {
    const set = outcomes()
    set.outcomes[0]!.status = 'blocked'
    set.outcomes[0]!.blockedReason = 'Approve the current report.'
    // Why: the reason is prose, not a request; the independent outcome keeps the run going.
    expect(classify(set)).toEqual({ group: 'waiting', completed: null })
    expect(sessionRunRowState(chain(set), { now: 1_000_000_000 }).phase).toBe('active')
    const asking = openHumanAttention(
      set,
      {
        kind: 'approval',
        scope: { outcomeId: 'delivery', outcomeRevision: set.outcomes[0]!.revision },
        ask: 'Approve the current report.',
        why: 'Only the owner can approve this report.',
        recipient: { type: 'owner' },
        action: { kind: 'review-outcome', label: 'Review', conditionId: 'file' },
        source: { type: 'review-condition', ref: 'delivery/file' }
      },
      150
    ).set
    expect(classify(asking)).toEqual({ group: 'attention', completed: null })
    expect(rowGroup(asking)).toBe('attention')
  })
  it('keeps a completed run sealed and classifies new obligations in a new run', () => {
    const complete = sealSessionRunCompletion(verify(verify(outcomes(), 0), 1), {
      now: 150,
      operationId: 'complete'
    })
    // Why: every condition carries a host receipt and the seal names them, so the caption may say
    // "complete"; a seal without that proof reads "finished" instead (see conversation-retention).
    expect(classify(complete)).toMatchObject({
      group: 'completed',
      completed: { reason: 'done' }
    })
    const next = reviseSessionOutcomeSet(
      undefined,
      {
        source: 'user',
        expectedRevision: 0,
        outcomes: [
          {
            id: 'new',
            title: 'New report',
            finish: 'complete',
            dependsOn: [],
            actions: [],
            conditions: [{ id: 'file', kind: 'file', target: '/output/new.txt' }]
          }
        ]
      },
      complete.continuation,
      200
    )
    expect(classify(complete).group).toBe('completed')
    expect(rowGroup(complete)).toBe('completed')
    expect(classify(next)).toEqual({ group: 'waiting', completed: null })
    expect(rowGroup(next)).toBe('waiting')
  })
  it('keeps personal Archive separate from completion evidence', () => {
    expect(classify(outcomes(), { archived: true })).toEqual({ group: 'archived', completed: null })
  })
})
