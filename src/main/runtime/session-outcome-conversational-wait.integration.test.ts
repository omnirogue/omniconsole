/**
 * Conversational waits through the real host tick: "wait 2 minutes, then tell me the time" holds
 * the plan as Waiting, then the SAME conversation receives the receipts and the next step, and the
 * plan completes when that turn ends. Only the conversation's pane is substituted.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { conversationSourceRowKey } from '../../shared/conversation-source'
import { readSessionRun } from '../../shared/session-run-lifecycle'
import type { SessionOutcomeCommit } from '../../shared/session-outcome-types'
import { outcomeRuntimeFixture } from './session-outcome-runtime-test-fixture'
import {
  installSessionOutcomeWaitFactsReader,
  type WaitFactsAnswer
} from './session-outcome-event-evidence'

type Fixture = ReturnType<typeof outcomeRuntimeFixture>
const fixtures: Fixture[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const fixture of fixtures.splice(0).toReversed()) {
    await fixture.dispose()
  }
})

const SOURCE = { worktreeId: 'folder:outcome', paneKey: 'source' }

function harness() {
  const fixture = outcomeRuntimeFixture(() => ({ body: 'unused' }))
  fixtures.push(fixture)
  const conversation = { state: 'done' as 'done' | 'working', at: 1_000, last: 'Filed the wait.' }
  const delivered: string[] = []
  const hook = vi.mocked(fixture.runtime.getFreshAgentHookStatusForHandle).getMockImplementation()
  vi.spyOn(fixture.runtime, 'getFreshAgentHookStatusForHandle').mockImplementation((handle) =>
    handle === 'source'
      ? ({
          state: conversation.state,
          stateStartedAt: conversation.at,
          lastAssistantMessage: conversation.last,
          interactivePrompt: null,
          updatedAt: conversation.at
        } as ReturnType<typeof fixture.runtime.getFreshAgentHookStatusForHandle>)
      : hook!(handle)
  )
  vi.spyOn(fixture.runtime, 'readSessionOutcomeSourceContext').mockImplementation(async () =>
    conversation.state === 'done'
      ? {
          paneKey: SOURCE.paneKey,
          handle: 'source',
          processIncarnation: 'test:source:1',
          agent: 'claude',
          model: 'opus-4',
          summary: conversation.last,
          files: []
        }
      : null
  )
  const send = vi.mocked(fixture.runtime.sendTerminalAgentPrompt).getMockImplementation()
  vi.spyOn(fixture.runtime, 'sendTerminalAgentPrompt').mockImplementation(
    async (handle, text, options) => {
      if (handle !== 'source') {
        return send!(handle, text, options)
      }
      delivered.push(text)
      conversation.state = 'working'
      conversation.at += 1
      return { handle, accepted: true, bytesWritten: text.length }
    }
  )
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

async function commit(
  f: ReturnType<typeof harness>,
  outcomes: SessionOutcomeCommit['outcomes']
): Promise<void> {
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

const slackWait = (since: string): SessionOutcomeCommit['outcomes'][number] => ({
  id: 'wait',
  title: 'Iris approves on Slack',
  finish: 'complete',
  dependsOn: [],
  actions: [],
  conditions: [
    {
      id: 'iris',
      kind: 'event',
      label: 'Iris approves on Slack',
      target: 'Iris approves on Slack',
      event: {
        source: 'slack',
        match: 'approve',
        personId: 'emp_iris',
        personName: 'Iris',
        ref: 'slack:D1:1727190000.1',
        since
      }
    }
  ]
})

describe('a chat-filed wait continues the same conversation', () => {
  it('waits for the time, then hands the conversation its next step and completes', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-09-24T16:00:00Z') })
    const f = harness()
    const at = new Date(Date.now() + 120_000).toISOString()
    const outcomes: SessionOutcomeCommit['outcomes'] = [
      {
        id: 'wait',
        title: 'Wait 2 minutes',
        finish: 'complete',
        dependsOn: [],
        actions: [],
        conditions: [
          {
            id: 'two_minutes',
            kind: 'event',
            label: 'Two minutes pass',
            target: 'Two minutes pass',
            event: { source: 'time', match: 'at', at }
          }
        ]
      },
      {
        id: 'tell',
        title: 'Tell me the time',
        finish: 'complete',
        dependsOn: ['wait'],
        conditions: [{ id: 'answered', kind: 'session', target: SOURCE.paneKey }],
        actions: [
          {
            id: 'tell_time',
            instruction: 'tell me the time',
            conditionIds: ['answered'],
            authority: 'existing-user-authority',
            agent: 'claude',
            route: 'same-session'
          }
        ]
      }
    ]
    await commit(f, outcomes)

    await f.settle()
    const waiting = f.service.get('chain').outcomeSet!
    expect(f.delivered).toEqual([])
    expect(readSessionRun(waiting).phase).toBe('waiting')
    expect(waiting.outcomes[0]!.block).toMatchObject({ class: 'waiting', code: 'event-wait' })
    expect(waiting.outcomes[0]!.waits?.[0]).toMatchObject({ status: 'pending' })

    vi.setSystemTime(Date.now() + 121_000)
    await f.settle()
    await f.settle()
    expect(f.delivered).toHaveLength(1)
    expect(f.delivered[0]).toContain('The wait has cleared. What arrived:')
    expect(f.delivered[0]).toContain('- Two minutes pass')
    expect(f.delivered[0]).toContain('> tell me the time')
    // No worker was started: the conversation that asked is the one that continues.
    expect(f.launched).toEqual([])

    f.answer('It is 12:02 PM.')
    for (let index = 0; index < 4; index++) {
      await f.settle()
    }
    const done = f.service.get('chain').outcomeSet!
    expect(done.outcomes.map((outcome) => outcome.status)).toEqual(['satisfied', 'satisfied'])
    expect(readSessionRun(done).phase).toBe('completed')
    expect(f.delivered).toHaveLength(1)
  })

  it('says a Slack wait nobody can check is not scheduled, and keeps checking', async () => {
    let answer: WaitFactsAnswer = {
      status: 'unavailable',
      reason: 'omnios does not serve wait facts yet.'
    }
    installSessionOutcomeWaitFactsReader(async () => answer)
    const f = harness()
    await commit(f, [slackWait(new Date().toISOString())])
    await f.settle()
    const down = f.service.get('chain').outcomeSet!
    expect(readSessionRun(down)).toMatchObject({
      phase: 'waiting',
      wake: 'Follow-up not scheduled: omnios does not serve wait facts yet.'
    })
    answer = { status: 'pending' }
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 31_000 })
    await f.settle()
    expect(readSessionRun(f.service.get('chain').outcomeSet!)).toMatchObject({
      phase: 'waiting',
      wake: 'Iris ○ on Slack'
    })
  })

  it('asks the owner on a reply that is not a yes, and continues when they say so', async () => {
    installSessionOutcomeWaitFactsReader(async () => ({
      status: 'needs_you',
      reason: 'Iris replied without approving.',
      evidence: {
        at: new Date().toISOString(),
        by: { person_id: 'emp_iris', name: 'Iris' },
        link: 'https://slack.test/p2',
        excerpt: 'not yet, tomorrow',
        kind: 'slack_reply'
      }
    }))
    const f = harness()
    await commit(f, [slackWait(new Date().toISOString())])
    await f.settle()
    const asking = f.service.get('chain').outcomeSet!
    const run = readSessionRun(asking)
    expect(run.phase).toBe('needs-you')
    expect(run.attention[0]!.ask).toBe(
      'Iris replied on Slack: "not yet, tomorrow". Keep waiting, continue anyway, or cancel?'
    )
    await f.service.waitChoice({
      id: 'chain',
      expectedRevision: asking.revision,
      outcomeId: 'wait',
      conditionId: 'iris',
      choice: 'continue'
    })
    await f.settle()
    const after = f.service.get('chain').outcomeSet!
    expect(after.outcomes[0]!.status).toBe('satisfied')
    expect(after.outcomes[0]!.evidence[0]!.receipt).toMatch(/^owner-continued:/)
    expect(readSessionRun(after).phase).toBe('completed')
  })

  it('cancels the rest of the plan when the owner says so', async () => {
    installSessionOutcomeWaitFactsReader(async () => ({
      status: 'needs_you',
      reason: 'Iris replied without approving.'
    }))
    const f = harness()
    await commit(f, [slackWait(new Date().toISOString())])
    await f.settle()
    const asking = f.service.get('chain')
    await f.service.waitChoice({
      id: 'chain',
      expectedRevision: asking.outcomeSet!.revision,
      outcomeId: 'wait',
      conditionId: 'iris',
      choice: 'cancel'
    })
    await f.settle()
    const cancelled = f.service.get('chain')
    expect(cancelled.state).toBe('cancelled')
    expect(cancelled.outcomeSet!.attention?.filter((request) => request.state === 'open')).toEqual(
      []
    )
    expect(f.delivered).toEqual([])
  })
})
