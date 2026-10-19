/**
 * W22-20 Phase 1, driven through the real host tick: a same-session step whose agent answered
 * without writing the promised file is asked to finish it in the same conversation, and the run
 * completes once the file exists — or fails as before once the repairs are spent.
 *
 * Substituted only at a conversation's two boundaries, as the same-conversation tests do: the
 * bytes that go into its pane, and the reading of the turn that came back.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../persistence/loading-store/write-scheduling', () => ({ scheduleSave: vi.fn() }))
import { PromptQueuePersistence } from '../persistence/loading-store/prompt-queue-persistence'
import type { WriteSchedulingOperations } from '../persistence/loading-store/write-scheduling'
import { conversationSourceRowKey } from '../../shared/conversation-source'
import type { PersistedState } from '../../shared/persisted-state-types'
import type { SessionChainAgentStep } from '../../shared/session-chain-types'
import { sessionOutcomeProgress } from '../../shared/session-outcome-state'
import {
  installSessionOutcomeDeliverableRepairStore,
  SessionOutcomeDeliverableRepairStore
} from './session-outcome-deliverable-repair-store'
import { outcomeRuntimeFixture } from './session-outcome-runtime-test-fixture'

type Fixture = ReturnType<typeof outcomeRuntimeFixture>
const fixtures: Fixture[] = []
let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'deliverable-repair-int-'))
  installSessionOutcomeDeliverableRepairStore(
    new SessionOutcomeDeliverableRepairStore(join(directory, 'repairs.json'))
  )
})

afterEach(async () => {
  for (const fixture of fixtures.splice(0).toReversed()) {
    await fixture.dispose()
  }
  installSessionOutcomeDeliverableRepairStore(null)
  rmSync(directory, { recursive: true, force: true })
})

const SOURCE = { worktreeId: 'folder:outcome', paneKey: 'source' }

function harness() {
  const fixture = outcomeRuntimeFixture(() => ({ body: 'unused' }))
  fixtures.push(fixture)
  const conversation = {
    state: 'done' as 'done' | 'working',
    stateStartedAt: 1_000,
    lastAssistantMessage: 'Ready.'
  }
  const delivered: string[] = []
  const hook = vi.mocked(fixture.runtime.getFreshAgentHookStatusForHandle).getMockImplementation()
  vi.spyOn(fixture.runtime, 'getFreshAgentHookStatusForHandle').mockImplementation((handle) =>
    handle === 'source'
      ? ({
          state: conversation.state,
          stateStartedAt: conversation.stateStartedAt,
          lastAssistantMessage: conversation.lastAssistantMessage,
          interactivePrompt: null,
          updatedAt: conversation.stateStartedAt
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
          summary: conversation.lastAssistantMessage,
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
      conversation.stateStartedAt += 1
      return { handle, accepted: true, bytesWritten: text.length }
    }
  )
  // The conversation's own prompt queue, real, as the profile keeps it.
  const prompts = new PromptQueuePersistence(
    {
      state: { promptQueues: {} } as unknown as PersistedState,
      flushOrThrow: () => {},
      writesFrozen: false
    },
    {} as WriteSchedulingOperations
  )
  vi.spyOn(fixture.runtime, 'listPromptQueues').mockImplementation(() => prompts.listPromptQueues())
  vi.spyOn(fixture.runtime, 'readPromptQueue').mockImplementation((key) =>
    prompts.readPromptQueue(key)
  )
  vi.spyOn(fixture.runtime, 'enqueuePromptQueueEntry').mockImplementation((source, entry) =>
    prompts.enqueuePromptQueueEntry(source, entry)
  )
  vi.spyOn(fixture.runtime, 'markPromptQueueEntrySendingAndFlush').mockImplementation(
    (key, id, delivery) => prompts.markPromptQueueEntrySendingAndFlush(key, id, delivery)
  )
  vi.spyOn(fixture.runtime, 'settlePromptQueueEntry').mockImplementation((key, id, settlement) =>
    prompts.settlePromptQueueEntry(key, id, settlement)
  )
  vi.spyOn(fixture.runtime, 'removePromptQueueEntry').mockImplementation((key, id) =>
    prompts.removePromptQueueEntry(key, id)
  )
  return {
    ...fixture,
    delivered,
    answer: (text: string) => {
      conversation.state = 'done'
      conversation.stateStartedAt += 1
      conversation.lastAssistantMessage = text
    }
  }
}

async function commit(f: ReturnType<typeof harness>): Promise<void> {
  const step = {
    id: 'write',
    outcomeId: 'spec',
    agent: 'claude',
    prompt: 'STEP:write',
    status: 'queued',
    route: 'same-session'
  } as SessionChainAgentStep
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
      steps: [step],
      currentIndex: 0,
      state: 'waiting',
      createdAt: 1,
      updatedAt: 1
    },
    {
      expectedRevision: 0,
      source: 'user',
      outcomes: [
        {
          id: 'spec',
          title: 'Write the spec',
          finish: 'complete',
          dependsOn: [],
          stepIds: ['write'],
          actions: [],
          conditions: [{ id: 'saved', kind: 'file', target: join(f.workspace, 'spec.md') }]
        }
      ]
    }
  )
  f.service.dispose()
}

const outcomeOf = (f: ReturnType<typeof harness>) =>
  f.service.get('chain').outcomeSet!.outcomes.find((entry) => entry.id === 'spec')!

/** Ticks until the step's turn is delivered and answered without the file. */
async function finishWithoutFile(f: ReturnType<typeof harness>): Promise<void> {
  await f.service.tick()
  expect(f.delivered[0]).toContain('STEP:write')
  f.answer('Done — saved the spec.')
  await f.service.tick()
  await f.service.tick()
}

describe('a finished outcome whose promised file is missing', () => {
  it('asks the same conversation to finish it, and completes once the file exists', async () => {
    const f = harness()
    await commit(f)
    await finishWithoutFile(f)

    expect(f.delivered).toHaveLength(2)
    expect(f.delivered[1]).toMatch(
      /^\[from Deliverable check 1\/2\] “Write the spec” is not finished/
    )
    expect(f.delivered[1]).toContain(join(f.workspace, 'spec.md'))
    // The pass that sent it classified the outcome first; the next reads the repair in flight.
    await f.service.tick()
    expect(outcomeOf(f).block).toMatchObject({
      class: 'waiting',
      code: 'deliverable-repair',
      wake: 'repair turn'
    })
    expect(f.delivered).toHaveLength(2)

    writeFileSync(join(f.workspace, 'spec.md'), '# Spec\n')
    f.answer('Saved spec.md.')
    await f.service.tick()
    await f.service.tick()

    expect(outcomeOf(f).status).toBe('satisfied')
    expect(f.delivered).toHaveLength(2)
  })

  it('fails as before after two repair turns that wrote nothing', async () => {
    const f = harness()
    await commit(f)
    await finishWithoutFile(f)
    f.answer('Still done.')
    await f.service.tick()
    await f.service.tick()

    // The first repair turn changed nothing, so no second repair is sent.
    expect(f.delivered).toHaveLength(2)
    expect(outcomeOf(f).block).toMatchObject({ class: 'failed', code: 'deliverable-unverified' })
    expect(sessionOutcomeProgress(f.service.get('chain').outcomeSet!).phase).toBe('failed')
    await f.service.tick()
    expect(f.delivered).toHaveLength(2)
  })
})
