/**
 * The Up next header is the run's phase, read from the ONE policy.
 *
 * The evidence this pins (`docs/reference/session-run-lifecycle.md`): the dispatch watchdog's
 * "No activity was observed for 180s…" sentence reached the person as "Stopped at stage 1 of 2 ·
 * needs you" because any blocked outcome made the header `blocked`; every finished chain printed
 * "Done · closed" with the set's last write time, whether or not anything was closed; and the
 * finished count read one outcome while the head read them all ("0 of 2").
 */
import { describe, expect, it } from 'vitest'
import type { SessionChain, SessionChainAgentStep } from '../../shared/session-chain-types'
import type { HumanAttentionRequest } from '../../shared/session-human-attention'
import type { SessionOutcomeBlock } from '../../shared/session-outcome-block'
import { sessionOutcomeStepActionId } from '../../shared/session-outcome-identity'
import {
  sessionOutcomeConditionKey,
  type SessionOutcome,
  type SessionOutcomeAttempt,
  type SessionOutcomeCondition,
  type SessionOutcomeSet
} from '../../shared/session-outcome-types'
import { UP_NEXT_REASON_KEYS, type UpNextView } from '../../shared/up-next-types'
import { projectUpNext } from './up-next-projection'

const NOW = 1_700_000_000_000
const STALL =
  "No activity was observed for 180s after this step's instruction was accepted, so the step is not running. Open that conversation to see what happened, then run the step again."

const seat = (id: string, over: Partial<SessionChainAgentStep> = {}): SessionChainAgentStep =>
  ({
    id,
    agent: 'claude',
    prompt: 'Improve the receipt signing.',
    presetId: 'improve',
    status: 'queued',
    ...over
  }) as SessionChainAgentStep

const attempt = (
  stepId: string,
  over: Partial<SessionOutcomeAttempt> = {}
): SessionOutcomeAttempt =>
  ({
    id: `a_${stepId}`,
    outcomeId: 'o1',
    actionId: sessionOutcomeStepActionId(stepId),
    actionKey: `k_${stepId}`,
    outcomeRevision: 1,
    state: 'completed',
    startedAt: NOW - 60_000,
    updatedAt: NOW - 10_000,
    ...over
  }) as SessionOutcomeAttempt

const condition = (id: string): SessionOutcomeCondition => ({ id, kind: 'report', target: id })

/** A receipt the reconciler keeps: same outcome, revision, condition key, kind and target. */
const receipt = (outcomeId: string, conditionId: string) => ({
  id: `ev_${conditionId}`,
  outcomeId,
  conditionId,
  outcomeRevision: 1,
  conditionKey: sessionOutcomeConditionKey(condition(conditionId)),
  kind: 'report' as const,
  target: conditionId,
  receipt: `report:${conditionId}`,
  verifiedAt: NOW - 20_000,
  verifier: 'execution-host' as const
})

const outcome = (id: string, over: Partial<SessionOutcome> = {}): SessionOutcome =>
  ({
    id,
    title: `Outcome ${id}`,
    finish: 'complete',
    dependsOn: [],
    conditions: [condition(`${id}_c`)],
    actions: [],
    revision: 1,
    status: 'pending',
    evidence: [],
    ...over
  }) as SessionOutcome

const proven = (id: string): SessionOutcome =>
  outcome(id, { status: 'satisfied', evidence: [receipt(id, `${id}_c`)] })

const request = (over: Partial<HumanAttentionRequest> = {}): HumanAttentionRequest => ({
  id: 'att_1',
  kind: 'clarification',
  scope: { outcomeId: 'o1', outcomeRevision: 1, attemptId: 'a_s1' },
  ask: 'Answer Claude Code’s question: Which price list is current?',
  why: 'Claude Code cannot choose this for you and is waiting for your answer.',
  recipient: { type: 'owner' },
  action: { kind: 'open-conversation', label: 'Answer', paneKey: 'tab-9:leaf-1' },
  source: { type: 'agent-prompt', ref: 'Which price list is current?' },
  state: 'open',
  openedAt: NOW - 5_000,
  ...over
})

type World = Partial<
  Pick<
    SessionOutcomeSet,
    | 'outcomes'
    | 'attempts'
    | 'completedSteps'
    | 'attention'
    | 'completion'
    | 'disposition'
    | 'sessionFinish'
  >
> & { steps?: SessionChain['steps']; unowned?: boolean }

function view(world: World): UpNextView {
  const { steps, unowned, ...set } = world
  const chain = {
    id: 'source_1',
    workspacePath: '/w',
    worktreeId: 'wt',
    hostId: 'local',
    sourcePaneKey: 'tab-1:leaf-1',
    sourceRowKey: JSON.stringify(['local', 'wt', 'tab-1:leaf-1']),
    auto: true,
    steps: steps ?? [seat('s1')],
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: NOW - 30_000,
    outcomeSet: {
      schemaVersion: 1,
      revision: 3,
      outcomes: [outcome('o1')],
      removals: [],
      attempts: [],
      continuation: {
        owner: 'execution-host',
        hostId: 'local',
        epoch: 'e1',
        state: unowned ? 'unverifiable' : 'owned'
      },
      // Deliberately NOT a time anything happened at: a header that prints it is wrong.
      updatedAt: NOW - 30_000,
      ...set
    }
  } as unknown as SessionChain
  return projectUpNext({
    conversationId: { kind: 'pty', worktreeId: 'wt', paneKey: 'tab-1:leaf-1' },
    rowKey: 'r',
    chain,
    queue: null,
    drafts: [],
    busy: false,
    now: NOW
  })
}

/** A stage whose worker the watchdog failed, with the outcome blocked for `block`'s class. */
const stalled = (block?: SessionOutcomeBlock): World => ({
  outcomes: [
    outcome('o1', { status: 'blocked', blockedReason: STALL, ...(block ? { block } : {}) })
  ],
  attempts: [attempt('s1', { state: 'blocked', error: STALL })]
})

describe('a 180 s stall', () => {
  it('reads as recovering while the host will relaunch, and never as needs-you', () => {
    const until = NOW + 15_000
    const { header, blocks } = view(
      stalled({ class: 'recovering', code: 'worker-stalled', since: NOW - 20_000, until })
    )
    expect(header).toEqual({ state: 'recovering', recoveringUntil: until, stage: { n: 1, of: 1 } })
    expect(blocks[0]).toMatchObject({ kind: 'agent', state: 'recovering', locked: true })
    // The sentence is carried as a diagnostic on the stage and nowhere in the header.
    expect(JSON.stringify(header)).not.toContain('No activity')
    expect(blocks[0]).toMatchObject({ progress: { blockedReason: STALL } })
  })

  it('reads as failed once recovery is exhausted, with the sentence only as the diagnostic', () => {
    const { header, blocks, now } = view(
      stalled({ class: 'failed', code: 'worker-stalled', since: NOW - 20_000 })
    )
    expect(header).toEqual({
      state: 'failed',
      failure: { code: 'worker-stalled', reason: STALL },
      stage: { n: 1, of: 1 }
    })
    expect(header.attention).toBeUndefined()
    expect(blocks[0]).toMatchObject({ state: 'failed', progress: { stopCode: 'worker-stalled' } })
    expect(now).toEqual({ kind: 'stage', blockId: blocks[0]!.id })
  })

  it('reads a legacy block nobody classified as failed / unclassified', () => {
    expect(view(stalled()).header).toMatchObject({
      state: 'failed',
      failure: { code: 'unclassified', reason: STALL }
    })
  })
})

describe('needs you', () => {
  it('is the open requests addressed to the owner, each with its direct action', () => {
    const { header, blocks } = view({
      outcomes: [outcome('o1', { status: 'running' })],
      attempts: [attempt('s1', { state: 'running' })],
      attention: [request()]
    })
    expect(header).toEqual({
      state: 'needs-you',
      stage: { n: 1, of: 1 },
      attention: [
        {
          id: 'att_1',
          kind: 'clarification',
          ask: 'Answer Claude Code’s question: Which price list is current?',
          why: 'Claude Code cannot choose this for you and is waiting for your answer.',
          action: { kind: 'open-conversation', label: 'Answer', paneKey: 'tab-9:leaf-1' }
        }
      ]
    })
    expect(blocks[0]).toMatchObject({ state: 'needs-you' })
  })

  it('is not raised by a request whose attempt is no longer the current one', () => {
    const { header } = view({
      outcomes: [outcome('o1', { status: 'running' })],
      attempts: [attempt('s1', { state: 'running' })],
      attention: [request({ scope: { outcomeId: 'o1', outcomeRevision: 1, attemptId: 'a_old' } })]
    })
    // The stage is simply running: a stale request is nobody's alarm.
    expect(header).toEqual({ state: 'running', stage: { n: 1, of: 1 } })
  })

  it('reads a named person’s review as waiting for THEM, never as the owner’s needs-you', () => {
    const { header } = view({
      outcomes: [
        outcome('o1', {
          status: 'blocked',
          blockedReason: 'Awaiting verified execution-host evidence.',
          block: { class: 'waiting', code: 'awaiting-review', since: NOW - 1_000 }
        })
      ],
      attempts: [attempt('s1')],
      completedSteps: ['s1'],
      attention: [
        request({
          id: 'att_review',
          kind: 'review',
          scope: { outcomeId: 'o1', outcomeRevision: 1 },
          recipient: { type: 'person', employeeId: 'emp_1', name: 'Jordan Taylor' },
          action: undefined
        })
      ]
    })
    expect(header).toEqual({ state: 'waiting', wake: 'Jordan Taylor' })
    expect(header.attention).toBeUndefined()
  })

  it('says who a delivered review is out with while the policy registers no stop at all', () => {
    // The host keeps the outcome pending while it polls for the reply, so the run is `active`
    // and nothing is in flight: that is a wait on a named person, not "idle · waiting for you".
    const review = {
      id: 'h1',
      kind: 'handoff',
      status: 'delivered',
      handoff: {
        savedAt: NOW - 60_000,
        includeSummary: true,
        deliverables: { kind: 'files', paths: ['src/a.ts'] },
        disposition: 'feedback',
        action: 'review',
        recipients: [
          {
            employeeId: 'emp_1',
            name: 'Jordan Taylor',
            operationId: 'op_h1',
            delivery: 'sent',
            at: NOW - 60_000
          }
        ]
      }
    } as unknown as SessionChain['steps'][number]
    const { header, blocks } = view({
      steps: [seat('s1'), review],
      outcomes: [
        outcome('o1', {
          conditions: [
            condition('o1_c'),
            { id: 'o1_feedback', kind: 'review', target: 'emp_1', recipientId: 'emp_1' }
          ]
        })
      ],
      attempts: [attempt('s1')],
      completedSteps: ['s1', 'h1']
    })
    expect(blocks.map((block) => [block.kind, block.state])).toEqual([
      ['agent', 'done'],
      ['person', 'waiting']
    ])
    expect(header).toEqual({ state: 'waiting', wake: 'Jordan Taylor' })
  })

  it('reads lost contact with the execution host as waiting, not as a request', () => {
    const { header } = view({ ...stalled(), unowned: true })
    expect(header).toMatchObject({ state: 'waiting', wake: 'execution host' })
  })
})

describe('a finished run', () => {
  const done: World = {
    outcomes: [proven('o1')],
    attempts: [attempt('s1')],
    completedSteps: ['s1']
  }
  const seal = { at: NOW - 5_000, outcomes: [{ id: 'o1', revision: 1 }], evidenceIds: ['ev_o1_c'] }
  const disposition = (over: Partial<NonNullable<SessionOutcomeSet['disposition']>>) => ({
    intent: 'close' as const,
    state: 'pending' as const,
    operationId: 'op_1',
    attempts: 0,
    updatedAt: NOW - 5_000,
    ...over
  })

  it('is Completed, not closed, when there was no terminal action', () => {
    const { header, now, blocks, canAdd } = view(done)
    expect(header).toEqual({ state: 'completed' })
    expect(now).toEqual({ kind: 'completed', at: NOW })
    expect(blocks.some((block) => block.kind === 'done')).toBe(false)
    // A finished run takes nothing more, closed or not.
    expect(canAdd.agent).toBe(false)
    expect(canAdd.reasons.prompt).toBe(UP_NEXT_REASON_KEYS.sessionClosed)
  })

  it('reads the legacy `me` finish as Completed too: it never asked for a close', () => {
    const { header, blocks } = view({
      ...done,
      sessionFinish: { action: 'me' },
      completion: seal,
      disposition: disposition({ intent: 'completed', state: 'applied', appliedAt: NOW - 5_000 })
    })
    expect(header).toEqual({ state: 'completed', completedAt: NOW - 5_000 })
    expect(blocks.some((block) => block.kind === 'done')).toBe(false)
  })

  it('is closed only once a window reported the close, at the time it reported', () => {
    const applied = NOW - 1_000
    const { header, now, blocks } = view({
      ...done,
      sessionFinish: { action: 'end' },
      completion: seal,
      disposition: disposition({ state: 'applied', appliedAt: applied })
    })
    expect(header).toEqual({
      state: 'closed',
      completedAt: NOW - 5_000,
      closedAt: applied,
      disposition: { intent: 'close', state: 'applied', appliedAt: applied }
    })
    expect(now).toEqual({ kind: 'closed', at: applied })
    expect(blocks.at(-1)).toMatchObject({ kind: 'done', state: 'done', closedAt: applied })
  })

  it('stays Completed while the close is pending, and when it failed', () => {
    const pending = view({
      ...done,
      sessionFinish: { action: 'end' },
      completion: seal,
      disposition: disposition({})
    })
    expect(pending.header).toEqual({
      state: 'completed',
      completedAt: NOW - 5_000,
      disposition: { intent: 'close', state: 'pending' }
    })
    const doneBlock = pending.blocks.at(-1)!
    expect(doneBlock).toMatchObject({ kind: 'done', state: 'done', finish: 'close' })
    expect(doneBlock.kind === 'done' && doneBlock.closedAt).toBeUndefined()
    const failed = view({
      ...done,
      sessionFinish: { action: 'end' },
      completion: seal,
      disposition: disposition({ state: 'failed', attempts: 5, lastError: 'The tab is pinned.' })
    })
    expect(failed.header).toMatchObject({
      state: 'completed',
      disposition: { intent: 'close', state: 'failed', error: 'The tab is pinned.' }
    })
  })

  it('is Completed with a saved note once the session was filed in its folder', () => {
    const applied = NOW - 2_000
    const { header, blocks } = view({
      ...done,
      sessionFinish: { action: 'save', folderId: 'folder-1' },
      completion: seal,
      disposition: disposition({
        intent: 'save',
        folderId: 'folder-1',
        state: 'applied',
        appliedAt: applied
      })
    })
    expect(header).toEqual({
      state: 'completed',
      completedAt: NOW - 5_000,
      disposition: { intent: 'save', state: 'applied', folderId: 'folder-1', appliedAt: applied }
    })
    expect(blocks.at(-1)).toMatchObject({ kind: 'done', finish: 'save', savedAt: applied })
  })

  it('exposes no queue and no attention: what it never reached is not still to come', () => {
    const { header, queuedCount, summary, blocks } = view({
      ...done,
      steps: [seat('s1'), seat('s2')],
      completion: seal,
      // A stale request and a stale block: a sealed run is read exactly as it was proven.
      attention: [request({ scope: { outcomeId: 'o1', outcomeRevision: 1 } })]
    })
    expect(header.state).toBe('completed')
    expect(header.attention).toBeUndefined()
    expect(blocks.map((block) => block.state)).toEqual(['done', 'queued'])
    expect(queuedCount).toBe(0)
    expect(summary).toMatchObject({ stages: 0, executions: 0, prompts: 0, people: 0 })
    expect(summary.finished).toMatchObject({ stages: 2 })
  })

  it('does not let a late stopped attempt reopen a proven outcome', () => {
    const { header, blocks } = view({
      outcomes: [proven('o1')],
      attempts: [attempt('s1', { state: 'blocked', error: STALL })],
      completedSteps: ['s1'],
      completion: seal
    })
    expect(header.state).toBe('completed')
    expect(blocks[0]).toMatchObject({ state: 'done' })
  })
})

describe('Done When is counted over every outcome', () => {
  it('counts both outcomes’ conditions, so "1 of 2" is two CONDITIONS, not two stages', () => {
    const { summary, header } = view({
      outcomes: [proven('o1'), outcome('o2', { status: 'satisfied' })],
      attempts: [attempt('s1')],
      completedSteps: ['s1'],
      completion: {
        at: NOW - 5_000,
        outcomes: [
          { id: 'o1', revision: 1 },
          { id: 'o2', revision: 1 }
        ],
        evidenceIds: ['ev_o1_c']
      }
    })
    expect(header.state).toBe('completed')
    expect(summary.finished).toMatchObject({ doneWhenMet: 1, doneWhenTotal: 2 })
  })
})
