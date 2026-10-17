/**
 * Kept proof (`reports/handoff-diagnosis.md`, D4), driven through the real outcome host.
 *
 * Two chains in Sal's profile (`source_b3cefdb0…`, `source_4caddd31…`) earned the receipt of their
 * source session, had their tab closed 31 s and 53 s later, and were stranded for good: losing
 * contact with the pane retired the receipt, the run read "Source execution is unverifiable", and
 * nobody can reopen a closed tab. The only thing those runs were really waiting for was the owner's
 * own review. Losing contact observes nothing, so it spends nothing already earned.
 */
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcomeDefinition } from '../../shared/session-outcome-types'
import { readSessionRun } from '../../shared/session-run-lifecycle'
import { outcomeRuntimeFixture } from './session-outcome-runtime-test-fixture'

const T0 = 1_800_000_000_000
const UNVERIFIABLE = 'Source execution is unverifiable'

const fixtures: ReturnType<typeof outcomeRuntimeFixture>[] = []
afterEach(async () => {
  for (const entry of fixtures.splice(0)) {
    await entry.dispose()
  }
})

function fixture() {
  const f = outcomeRuntimeFixture(() => ({ body: 'no worker runs in this test' }))
  fixtures.push(f)
  const clock = { now: T0 }
  ;(f.service as unknown as { now: () => number }).now = () => clock.now
  // Driven by hand: a commit's own first pass would race the passes a test counts.
  vi.spyOn(f.service, 'start').mockImplementation(() => {})
  const pass = async (): Promise<void> => {
    clock.now += 2_000
    await f.service.tick()
  }
  const run = () =>
    readSessionRun(f.service.get('chain').outcomeSet!, { now: clock.now, planVersion: 1 })
  const outcome = () => f.service.get('chain').outcomeSet!.outcomes[0]!
  return { ...f, clock, pass, run, outcome }
}

const chain = (workspace: string): SessionChain => ({
  id: 'chain',
  workspacePath: workspace,
  worktreeId: 'folder:outcome',
  hostId: 'local',
  sourcePaneKey: 'source',
  sourceRowKey: 'row',
  auto: true,
  steps: [],
  currentIndex: 0,
  state: 'waiting',
  createdAt: 1,
  updatedAt: 1
})

const reviewedByOwner = (): SessionOutcomeDefinition =>
  ({
    id: 'outcome',
    title: 'The report is ready',
    finish: 'my-review',
    dependsOn: [],
    conditions: [
      // A folder workspace identifies the result under review by its named deliverable.
      { id: 'report', kind: 'file', target: './report.md' },
      // The owner's review no longer holds a run open (it goes to Done); a check the world has not
      // satisfied yet is what keeps these runs waiting while the source receipt is watched.
      {
        id: 'later',
        kind: 'command',
        target: 'cat',
        verification: { program: 'cat', args: ['later.md'], expectedStdout: 'Later.' }
      },
      { id: 'my-review', kind: 'review', label: 'I have reviewed the result', target: 'outcome' }
    ],
    actions: []
  }) as unknown as SessionOutcomeDefinition

/** A pursuit that ends its session, with the source receipt earned and one deliverable still to come. */
async function receiptEarned() {
  const f = fixture()
  await f.service.commit(chain(f.workspace), {
    expectedRevision: 0,
    source: 'user',
    outcomes: [reviewedByOwner()],
    sessionFinish: { action: 'end' }
  })
  f.write('report.md', 'The report.')
  await f.pass()
  expect(f.outcome().evidence.map((entry) => entry.kind)).toEqual(['file', 'session'])
  return f
}

const sessionReceipt = (f: ReturnType<typeof fixture>) =>
  f.outcome().evidence.find((entry) => entry.kind === 'session')

const closeTab = (f: ReturnType<typeof fixture>): void => {
  vi.mocked(f.runtime.resolveTerminalPane).mockImplementation(() => {
    throw new Error('The source pane has been closed.')
  })
}

it('keeps the session receipt when the tab is closed, and the run finishes into Done without asking', async () => {
  const f = await receiptEarned()
  const earned = f.outcome().evidence

  closeTab(f)
  await f.pass()
  await f.pass()

  expect(f.outcome().evidence).toEqual(earned)
  expect(f.service.get('chain').outcomeSet!.evidenceHistory ?? []).toEqual([])
  expect(f.outcome().blockedReason ?? '').not.toContain(UNVERIFIABLE)
  // Nothing here is the owner's to answer: the run waits on the world, not on them.
  expect(f.run().phase).toBe('waiting')
  expect(f.run().attention).toEqual([])

  // The last deliverable lands, with the tab long gone: the owner's review is where the result
  // goes (Done), not a question — the run seals and its finish is carried out.
  f.write('later.md', 'Later.')
  // A command is polled at most every 30 s; the pass after that reads it.
  f.clock.now += 30_000
  await f.pass()
  await f.pass()
  const done = f.service.get('chain')
  expect(done.state).toBe('done')
  expect(done.outcomeSet!.completion).toBeDefined()
  expect(done.outcomeSet!.attention ?? []).toEqual([])
  expect(done.outcomeSet!.disposition).toMatchObject({ intent: 'close', state: 'pending' })
})

it('still retires the receipt on a POSITIVE contrary reading: the source is working again', async () => {
  const f = await receiptEarned()
  const receipt = sessionReceipt(f)!
  vi.mocked(f.runtime.getFreshAgentHookStatusForHandle).mockReturnValue({
    state: 'working',
    lastAssistantMessage: null,
    interactivePrompt: null,
    stateStartedAt: T0,
    updatedAt: T0
  })
  await f.pass()

  expect(sessionReceipt(f)).toBeUndefined()
  expect(f.service.get('chain').outcomeSet!.evidenceHistory).toEqual([receipt])
  expect(f.run().phase).not.toBe('needs-you')
})

it('puts back the receipt an older host retired, for a run that is already stranded', async () => {
  const f = await receiptEarned()
  const earned = f.service.get('chain')
  const receipt = sessionReceipt(f)!
  closeTab(f)
  // The record an older host left behind: the receipt in history, a legacy reason, no class.
  f.runtime.replaceSessionChainOutcomesAndFlush(
    {
      ...earned,
      state: 'waiting',
      error: `${UNVERIFIABLE}. Restore its host or source session before continuing.`,
      outcomeSet: {
        ...earned.outcomeSet!,
        attention: [],
        evidenceHistory: [receipt],
        outcomes: earned.outcomeSet!.outcomes.map((entry) => ({
          ...entry,
          status: 'blocked' as const,
          blockedReason: `${UNVERIFIABLE}. Restore its host or source session before continuing.`,
          block: undefined,
          evidence: entry.evidence.filter((proof) => proof.id !== receipt.id)
        }))
      }
    },
    earned.outcomeSet!.revision
  )
  expect(f.run().phase).toBe('failed')

  // Past the command's 30 s poll interval, so its own reading replaces the legacy reason.
  f.clock.now += 30_000
  await f.pass()

  // Restored, never minted: the very receipt that was earned, id and all.
  expect(sessionReceipt(f)).toEqual(receipt)
  expect(f.outcome().blockedReason ?? '').not.toContain(UNVERIFIABLE)
  expect(f.run().phase).toBe('waiting')
  expect(f.run().attention).toEqual([])
})

it('restores nothing a finish commit discarded, and nothing while the source can be read', async () => {
  const f = await receiptEarned()
  const earned = f.service.get('chain')
  const receipt = sessionReceipt(f)!
  const stranded = (sourceVersion = earned.outcomeSet!.continuation.sourceVersion) =>
    f.runtime.replaceSessionChainOutcomesAndFlush(
      {
        ...f.service.get('chain'),
        outcomeSet: {
          ...earned.outcomeSet!,
          continuation: { ...earned.outcomeSet!.continuation, sourceVersion },
          attention: [],
          evidenceHistory: [receipt],
          outcomes: earned.outcomeSet!.outcomes.map((entry) => ({
            ...entry,
            evidence: entry.evidence.filter((proof) => proof.id !== receipt.id)
          }))
        }
      },
      earned.outcomeSet!.revision
    )

  // The source is readable: it is read, and earns its own receipt instead of the old one.
  stranded()
  await f.pass()
  expect(sessionReceipt(f)).toMatchObject({ receipt: receipt.receipt })
  expect(sessionReceipt(f)!.id).not.toBe(receipt.id)

  // Out of contact, but the run holds a DIFFERENT source reading than the receipt was earned on.
  closeTab(f)
  stranded('f'.repeat(64))
  await f.pass()
  expect(sessionReceipt(f)).toBeUndefined()

  // In contact, with no hook row, and not yet quiet long enough to say: nothing was observed, so
  // nothing is spent — and nothing is put back either, because this pane is read again next pass.
  vi.mocked(f.runtime.resolveTerminalPane).mockReturnValue({
    handle: 'source',
    connected: true,
    tabId: 'source',
    leafId: 'leaf',
    ptyId: 'pty'
  })
  vi.mocked(f.runtime.getFreshAgentHookStatusForHandle).mockReturnValue(null)
  vi.spyOn(f.runtime, 'readTerminal').mockResolvedValue({
    handle: 'source',
    status: 'running',
    tail: ['> ']
  } as never)
  vi.spyOn(f.runtime, 'getTerminalInteractiveWait').mockResolvedValue(null)
  vi.spyOn(f.runtime, 'getTerminalAgentStatus').mockResolvedValue({
    handle: 'source',
    isRunningAgent: true,
    status: 'idle'
  })
  stranded()
  await f.pass()
  expect(sessionReceipt(f)).toBeUndefined()
  expect(f.service.get('chain').outcomeSet!.evidenceHistory).toEqual([receipt])
})
