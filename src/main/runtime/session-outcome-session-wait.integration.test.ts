/**
 * "Wait for the billing session to finish, then tell me what it did" through the real host tick: the
 * plan waits while the other session has no result, the waiter is listed as waiting on it (so it is
 * never archived meanwhile), and when its result appears the SAME conversation is woken exactly once
 * with a receipt bound to that result. An exited waiter is resumed first, or reads Stalled.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { conversationSourceRowKey } from '../../shared/conversation-source'
import { readSessionRun } from '../../shared/session-run-lifecycle'
import type { SessionOutcomeCommit } from '../../shared/session-outcome-types'
import { installSessionResultCardReader } from '../session-steward/steward-awaited-session'
import { listSessionWaiters } from '../session-steward/steward-waiters'
import { installSameConversationReviver } from './session-outcome-conversation-revive'
import { outcomeRuntimeFixture } from './session-outcome-runtime-test-fixture'

type Fixture = ReturnType<typeof outcomeRuntimeFixture>
const fixtures: Fixture[] = []
const undo: (() => void)[] = []
afterEach(async () => {
  for (const restore of undo.splice(0)) {
    restore()
  }
  for (const fixture of fixtures.splice(0).toReversed()) {
    await fixture.dispose()
  }
})

const SOURCE = { worktreeId: 'folder:outcome', paneKey: 'source' }
const BILLING = 'billing:leaf'

function harness() {
  const fixture = outcomeRuntimeFixture(() => ({ body: 'unused' }))
  fixtures.push(fixture)
  const conversation = { state: 'done' as 'done' | 'working', at: 1_000, last: 'Filed the wait.' }
  const delivered: { handle: string; text: string }[] = []
  vi.spyOn(fixture.runtime, 'getFreshAgentHookStatusForHandle').mockImplementation(
    () =>
      ({
        state: conversation.state,
        stateStartedAt: conversation.at,
        lastAssistantMessage: conversation.last,
        interactivePrompt: null,
        updatedAt: conversation.at
      }) as ReturnType<typeof fixture.runtime.getFreshAgentHookStatusForHandle>
  )
  vi.spyOn(fixture.runtime, 'readSessionOutcomeSourceContext').mockImplementation(
    async (paneKey) =>
      conversation.state === 'done'
        ? {
            paneKey,
            handle: 'source',
            processIncarnation: 'test:source:1',
            agent: 'claude',
            model: 'opus-4',
            summary: conversation.last,
            files: []
          }
        : null
  )
  vi.spyOn(fixture.runtime, 'sendTerminalAgentPrompt').mockImplementation(async (handle, text) => {
    delivered.push({ handle, text })
    conversation.state = 'working'
    conversation.at += 1
    return { handle, accepted: true, bytesWritten: text.length }
  })
  vi.spyOn(fixture.runtime, 'listPromptQueues').mockImplementation(() => ({}))
  vi.spyOn(fixture.runtime, 'readPromptQueue').mockImplementation(() => null)
  return {
    ...fixture,
    delivered,
    answer: (text: string) => {
      conversation.state = 'done'
      conversation.at += 1
      conversation.last = text
    }
  }
}

const outcomes: SessionOutcomeCommit['outcomes'] = [
  {
    id: 'wait',
    title: 'Billing session finishes',
    finish: 'complete',
    dependsOn: [],
    actions: [],
    conditions: [
      {
        id: 'billing',
        kind: 'event',
        label: 'Billing session finishes',
        target: 'Billing session finishes',
        event: { source: 'session', match: 'result', ref: BILLING }
      }
    ]
  },
  {
    id: 'tell',
    title: 'Tell me what it did',
    finish: 'complete',
    dependsOn: ['wait'],
    conditions: [{ id: 'answered', kind: 'session', target: SOURCE.paneKey }],
    actions: [
      {
        id: 'tell_result',
        instruction: 'tell me what it did',
        conditionIds: ['answered'],
        authority: 'existing-user-authority',
        agent: 'claude',
        route: 'same-session'
      }
    ]
  }
]

async function commit(f: ReturnType<typeof harness>): Promise<void> {
  await f.service.commit(
    {
      id: 'chain',
      workspacePath: f.workspace,
      worktreeId: SOURCE.worktreeId,
      hostId: 'local',
      sourcePaneKey: SOURCE.paneKey,
      sourceRowKey: conversationSourceRowKey(SOURCE),
      auto: true,
      end: 'me',
      steps: [],
      currentIndex: 0,
      state: 'waiting',
      createdAt: 1,
      updatedAt: 1
    },
    { expectedRevision: 0, source: 'user', outcomes }
  )
  f.service.dispose()
}

async function settle(f: ReturnType<typeof harness>, times = 2): Promise<void> {
  for (let index = 0; index < times; index++) {
    await f.settle()
  }
}

describe('a session waiting on another session', () => {
  it('holds the other session, then wakes the waiter exactly once with a bound receipt', async () => {
    let card: { revision: string; summary: string } | null = null
    undo.push(installSessionResultCardReader((paneKey) => (paneKey === BILLING ? card : null)))
    const f = harness()
    await commit(f)
    await settle(f)

    const waiting = f.service.get('chain').outcomeSet!
    expect(f.delivered).toEqual([])
    expect(readSessionRun(waiting)).toMatchObject({
      phase: 'waiting',
      wake: 'Billing session finishes ○'
    })
    expect(waiting.outcomes[0]!.waits?.[0]).toMatchObject({
      status: 'pending',
      reason: `The session it waits on (pane ${BILLING}) has no finished result yet.`
    })
    expect(
      listSessionWaiters(f.runtime)
        .get(BILLING)
        ?.map((entry) => entry.paneKey)
    ).toEqual([SOURCE.paneKey])

    card = { revision: 'archive-op-1', summary: 'Billing retries fixed in PR #41.' }
    await settle(f)
    expect(f.delivered).toHaveLength(1)
    expect(f.delivered[0]!.text).toContain('The wait has cleared. What arrived:')
    expect(f.delivered[0]!.text).toContain(
      '- Billing session finishes — "Billing retries fixed in PR #41."'
    )
    expect(f.delivered[0]!.text).toContain('> tell me what it did')
    const cleared = f.service.get('chain').outcomeSet!
    const receipt = cleared.outcomes[0]!.evidence[0]!.receipt
    expect(receipt).toMatch(/^event:session:billing:leaf@card-[0-9a-f]{16}$/)
    // Picked up: the billing session is no longer held for this waiter.
    expect(listSessionWaiters(f.runtime).get(BILLING)).toBeUndefined()

    // A later result of the other session neither re-wakes the waiter nor rewrites its receipt.
    card = { revision: 'archive-op-2', summary: 'Something newer.' }
    f.answer('It fixed billing retries.')
    await settle(f, 4)
    const done = f.service.get('chain').outcomeSet!
    expect(f.delivered).toHaveLength(1)
    expect(done.outcomes.map((outcome) => outcome.status)).toEqual(['satisfied', 'satisfied'])
    expect(done.outcomes[0]!.evidence[0]!.receipt).toBe(receipt)
    expect(readSessionRun(done).phase).toBe('completed')
  })

  it('refuses at admission a session waiting on itself', async () => {
    const f = harness()
    const self = structuredClone(outcomes)
    self[0]!.conditions[0]!.event!.ref = SOURCE.paneKey
    await expect(
      f.service.commit(
        {
          id: 'chain',
          workspacePath: f.workspace,
          worktreeId: SOURCE.worktreeId,
          hostId: 'local',
          sourcePaneKey: SOURCE.paneKey,
          sourceRowKey: conversationSourceRowKey(SOURCE),
          auto: true,
          end: 'me',
          steps: [],
          currentIndex: 0,
          state: 'waiting',
          createdAt: 1,
          updatedAt: 1
        },
        { expectedRevision: 0, source: 'user', outcomes: self }
      )
    ).rejects.toThrow('A session cannot wait on its own result')
    f.service.dispose()
  })

  it('delivers into the resumed pane when the waiter had exited', async () => {
    const resumed = { worktreeId: SOURCE.worktreeId, paneKey: 'resumed:leaf', kind: 'pty' as const }
    const revive = vi.fn(async () => ({ kind: 'resumed' as const, source: resumed }))
    undo.push(installSameConversationReviver(revive))
    undo.push(installSessionResultCardReader(() => ({ revision: 'r1', summary: 'Done.' })))
    const f = harness()
    await commit(f)
    await settle(f, 3)
    expect(revive).toHaveBeenCalledTimes(1)
    expect(f.delivered).toHaveLength(1)
    const attempt = f.service.get('chain').outcomeSet!.attempts.at(-1)!
    expect(attempt.conversationTurn).toMatchObject({ paneKey: 'resumed:leaf' })
  })

  it('reads Stalled with the reason when the exited waiter cannot be resumed', async () => {
    undo.push(
      installSameConversationReviver(async () => ({
        kind: 'stalled',
        reason: 'Stalled: “Billing” exited and could not be resumed: no transcript.'
      }))
    )
    undo.push(installSessionResultCardReader(() => ({ revision: 'r1', summary: 'Done.' })))
    const f = harness()
    await commit(f)
    await settle(f, 3)
    expect(f.delivered).toEqual([])
    const attempt = f.service.get('chain').outcomeSet!.attempts.at(-1)!
    expect(attempt).toMatchObject({
      state: 'blocked',
      error: 'Stalled: “Billing” exited and could not be resumed: no transcript.'
    })
  })
})
