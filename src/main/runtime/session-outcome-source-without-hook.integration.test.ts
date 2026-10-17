/**
 * "My session finished and the handoff was never sent" (`reports/handoff-diagnosis.md`, D2/D3),
 * driven through the real outcome host.
 *
 * Chain `source_08ea603c…` was committed on a live terminal pane whose agent reported no hook row.
 * The source read `{ready:false, idle:true}` on every pass, the pass returned with no reason, and
 * the handoff waited for ever. Here the host establishes the ending from its own reading of the
 * pane, says what it is waiting for until it can, and never sends while the agent is at work.
 */
import { afterEach, expect, it, vi } from 'vitest'
import type { HandoffDetail } from '../../shared/console-handoff-contract'
import type { SessionChainHandoffStep } from '../../shared/session-chain-types'
import { readSessionRun } from '../../shared/session-run-lifecycle'
import { installSessionOutcomeHandoffReader } from './session-outcome-external-evidence'
import { installSessionOutcomeHandoffTransport } from './session-outcome-handoff'
import { outcomeRuntimeFixture } from './session-outcome-runtime-test-fixture'
import { SOURCE_IDLE_SETTLE_MS } from './session-outcome-source-quiet-pane'

const T0 = 1_800_000_000_000

const fixtures: ReturnType<typeof outcomeRuntimeFixture>[] = []
afterEach(async () => {
  for (const entry of fixtures.splice(0)) {
    await entry.dispose()
  }
})

type AgentReading = 'idle' | 'working' | null

/** The real host, a live source pane with NO hook row, and a handoff the hub accepts. */
function fixture(initial: AgentReading) {
  const receipts = new Map<string, HandoffDetail>()
  let sends = 0
  installSessionOutcomeHandoffTransport({
    principal: async () => 'company:person',
    hub: {
      upload: async (_task, file) => ({ path: file.name, sha256: file.sha256 }),
      send: async () => {
        throw new Error('Only the owned cardless fixture is available')
      },
      sendCardless: async (input) => {
        sends++
        receipts.set(input.operationId, {
          thread: {
            id: 'hth_test',
            board_task_id: null,
            author_employee_id: 'emp_author',
            recipient_employee_id: input.recipient,
            title: 'Test handoff',
            state: 'open',
            action: input.action ?? null,
            due_at: null,
            parent_thread_id: null,
            delivery_id: null,
            updated: new Date(T0).toISOString()
          },
          files: [],
          reviews: [],
          entries: []
        })
        return { thread_id: 'hth_test' }
      },
      uploadThreadFile: async () => ({ thread_id: 'hth_test' }),
      isRejected: () => false
    }
  })
  installSessionOutcomeHandoffReader(async () => ({ ok: true, data: [...receipts.values()][0]! }))
  const f = outcomeRuntimeFixture(() => ({ body: 'no worker runs in this test' }))
  fixtures.push(f)
  const pane = { agent: initial, tail: ['> '] }
  const clock = { now: T0 }
  ;(f.service as unknown as { now: () => number }).now = () => clock.now
  // Driven by hand: a commit's own first pass would race the passes a test counts.
  vi.spyOn(f.service, 'start').mockImplementation(() => {})
  vi.mocked(f.runtime.getFreshAgentHookStatusForHandle).mockReturnValue(null)
  vi.spyOn(f.runtime, 'readTerminal').mockImplementation(
    async (handle) =>
      ({ handle, status: 'running', tail: pane.tail, truncated: false, nextCursor: null }) as never
  )
  vi.spyOn(f.runtime, 'getTerminalInteractiveWait').mockResolvedValue(null)
  vi.spyOn(f.runtime, 'getTerminalAgentStatus').mockImplementation(async (handle) => ({
    handle,
    isRunningAgent: pane.agent !== null,
    status: pane.agent
  }))
  return {
    ...f,
    pane,
    clock,
    sends: () => sends,
    pass: async (ms = 2_000): Promise<void> => {
      clock.now += ms
      await f.service.tick()
    },
    set: () => f.service.get('chain').outcomeSet!,
    run: () =>
      readSessionRun(f.service.get('chain').outcomeSet!, { now: clock.now, planVersion: 1 })
  }
}

const handoff: SessionChainHandoffStep = {
  id: 'handoff',
  kind: 'handoff',
  outcomeId: 'delivery',
  status: 'queued',
  handoff: {
    revision: 1,
    taskId: null,
    taskTitle: 'Owned test',
    sessionLabel: 'Test',
    recipients: [
      {
        employeeId: 'emp_recipient',
        name: 'Test recipient',
        operationId: 'owned_operation_1',
        delivery: 'pending'
      }
    ],
    action: 'review',
    disposition: 'ownership-transfer',
    communicationType: 'question',
    deliverables: { kind: 'files', paths: [] },
    includeSummary: false,
    note: 'Here is what the session produced',
    savedAt: 1
  }
}

const commitHandoff = (f: ReturnType<typeof fixture>) =>
  f.service.commit(
    {
      id: 'chain',
      workspacePath: f.workspace,
      worktreeId: 'folder:outcome',
      hostId: 'local',
      sourcePaneKey: 'source',
      sourceRowKey: 'row',
      auto: true,
      steps: [handoff],
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
          id: 'delivery',
          title: 'Hand off',
          finish: 'human-handoff',
          dependsOn: [],
          stepIds: ['handoff'],
          actions: [],
          conditions: [
            {
              id: 'handoff',
              kind: 'handoff',
              target: 'emp_recipient',
              recipientId: 'emp_recipient'
            }
          ]
        }
      ]
    }
  )

/** Pass until the handoff went out, within a bound: a run that never sends fails the test. */
async function passUntilSent(f: ReturnType<typeof fixture>): Promise<void> {
  for (let pass = 0; pass < 6 && f.sends() === 0; pass++) {
    await f.pass()
  }
}

it('sends the handoff of an idle source that never reported a hook row, and is never silent', async () => {
  const f = fixture('idle')
  await commitHandoff(f)
  expect(f.set().continuation.sourceReady).not.toBe(true)

  // One pass in, the pane has not sat still long enough: the run WAITS, and says for what.
  await f.pass(SOURCE_IDLE_SETTLE_MS - 1_000)
  expect(f.sends()).toBe(0)
  expect(f.set().outcomes[0]).toMatchObject({
    status: 'blocked',
    block: { class: 'waiting', wake: expect.stringMatching(/\S/) }
  })
  expect(f.run()).toMatchObject({ phase: 'waiting', wake: expect.stringMatching(/\S/) })
  expect(f.run().attention).toEqual([])

  await passUntilSent(f)
  expect(f.sends()).toBe(1)
  expect(f.set().continuation).toMatchObject({
    state: 'owned',
    sourceReady: true,
    sourceVersion: expect.stringMatching(/^[a-f0-9]{64}$/)
  })
})

it('never sends while the source is visibly working, however long that lasts', async () => {
  const f = fixture('working')
  await commitHandoff(f)
  for (let pass = 0; pass < 5; pass++) {
    await f.pass(10 * 60_000)
    expect(f.sends()).toBe(0)
    expect(f.set().continuation.sourceReady).not.toBe(true)
    expect(f.set().outcomes[0]!.block).toMatchObject({
      class: 'waiting',
      wake: expect.stringMatching(/\S/)
    })
    expect(f.run().phase).toBe('waiting')
  }

  // Its turn ends: the same run goes on by itself.
  f.pane.agent = 'idle'
  f.pane.tail = ['> ', 'Finished.']
  await passUntilSent(f)
  expect(f.sends()).toBe(1)
})

it('never reads a pane that keeps printing as finished when it can read no agent status', async () => {
  const f = fixture(null)
  await commitHandoff(f)
  for (let pass = 0; pass < 40; pass++) {
    f.pane.tail = [`working… ${pass}`]
    await f.pass()
  }
  expect(f.sends()).toBe(0)
  expect(f.run().phase).toBe('waiting')
})

it('sends at once on a `done` row however old it is: an idle agent reports nothing further', async () => {
  const f = fixture('idle')
  vi.mocked(f.runtime.getFreshAgentHookStatusForHandle).mockReturnValue({
    state: 'done',
    lastAssistantMessage: 'The report is written.',
    interactivePrompt: null,
    stateStartedAt: T0 - 45 * 60_000,
    updatedAt: T0 - 45 * 60_000
  })
  await commitHandoff(f)
  expect(f.set().continuation.sourceReady).toBe(true)
  await passUntilSent(f)
  expect(f.sends()).toBe(1)
})
