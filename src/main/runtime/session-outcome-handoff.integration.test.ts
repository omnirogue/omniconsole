import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HandoffDetail, HandoffSendCardless } from '../../shared/console-handoff-contract'
import type { SessionChainHandoffStep } from '../../shared/session-chain-types'
import { SESSION_RECOVERY_BACKOFF_MS } from '../../shared/session-attempt-recovery'
import { sessionOutcomeProgress } from '../../shared/session-outcome-state'
import { readSessionRun } from '../../shared/session-run-lifecycle'
import { installSessionOutcomeHandoffReader } from './session-outcome-external-evidence'
import { installSessionOutcomeHandoffTransport } from './session-outcome-handoff'
import { outcomeRuntimeFixture } from './session-outcome-runtime-test-fixture'

const fixtures: ReturnType<typeof outcomeRuntimeFixture>[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.dispose()
  }
})

/**
 * The backoff of an automatic resend is read from `Date.now()` by the step runner, so these rows
 * move the clock instead of sleeping. It keeps running underneath, so nothing sees time stand still;
 * the fixture's `vi.restoreAllMocks()` puts the real one back.
 */
function movableClock(): { advance(ms: number): void } {
  const real = Date.now.bind(Date)
  let offset = 0
  vi.spyOn(Date, 'now').mockImplementation(() => real() + offset)
  return {
    advance: (ms) => {
      offset += ms
    }
  }
}

async function setup(
  feedback: boolean,
  rejecting = false,
  options: {
    working?: boolean
    history?: boolean
    messageOnly?: boolean
    folder?: boolean
    /** The file the handoff names is not written yet: the capture has to wait for it. */
    missingDeliverable?: boolean
  } = {}
) {
  const receipts = new Map<string, HandoffDetail>()
  const sentInputs: HandoffSendCardless[] = []
  let sends = 0,
    principal = 'company:person'
  installSessionOutcomeHandoffTransport({
    principal: async () => principal,
    hub: {
      upload: async (_task, file) => ({ path: file.name, sha256: file.sha256 }),
      send: async () => {
        throw new Error('Only the owned cardless fixture is available')
      },
      sendCardless: async (input) => {
        sends++
        sentInputs.push(input)
        if (rejecting) {
          throw new Error('recipient not in roster')
        }
        if (!receipts.has(input.operationId)) {
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
              updated: new Date().toISOString()
            },
            files: input.attachments.map((file, index) => ({
              id: `hfv_${index}`,
              path: file.name,
              name: file.name,
              sha256: file.sha256,
              size: file.size,
              version: 1,
              parent_version_id: null,
              current: true,
              available: true
            })),
            reviews: [],
            entries: []
          })
        }
        return { thread_id: 'hth_test' }
      },
      uploadThreadFile: async () => ({ thread_id: 'hth_test' }),
      isRejected: (error) => error instanceof Error && error.message.includes('roster')
    }
  })
  installSessionOutcomeHandoffReader(async () => ({ ok: true, data: [...receipts.values()][0]! }))
  const f = outcomeRuntimeFixture((spec, workspace) => {
    writeFileSync(join(workspace, 'other.txt'), 'independent done')
    return { body: spec }
  })
  fixtures.push(f)
  if (options.working) {
    vi.mocked(f.runtime.getFreshAgentHookStatusForHandle).mockReturnValue({
      state: 'working',
      lastAssistantMessage: null,
      interactivePrompt: null,
      stateStartedAt: Date.now(),
      updatedAt: Date.now()
    })
  }
  if (!options.missingDeliverable) {
    f.write('deliverable.txt', 'the exact requested file')
  }
  if (options.folder) {
    mkdirSync(join(f.workspace, 'folder'))
    f.write('folder/result.md', 'folder result\r\n')
  }
  if (options.history) {
    f.write(
      'session.jsonl',
      `${JSON.stringify({
        type: 'event_msg',
        payload: { type: 'user_message', message: 'Before completion' }
      })}\n`
    )
  }
  const step: SessionChainHandoffStep = {
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
      disposition: feedback ? 'feedback' : 'ownership-transfer',
      communicationType: 'question',
      deliverables: {
        kind: 'files',
        paths: options.messageOnly
          ? []
          : [
              join(f.workspace, 'deliverable.txt'),
              ...(options.folder ? [join(f.workspace, 'folder')] : [])
            ]
      },
      ...(options.history
        ? {
            transcriptSource: {
              kind: 'provider' as const,
              hostId: 'local' as const,
              agent: 'codex',
              sessionId: 'source-session',
              transcriptPath: join(f.workspace, 'session.jsonl')
            }
          }
        : {}),
      includeSummary: false,
      note: 'Review the test deliverable',
      savedAt: 1
    }
  }
  await f.service.commit(
    {
      id: 'chain',
      workspacePath: f.workspace,
      worktreeId: 'folder:outcome',
      hostId: 'local',
      sourcePaneKey: 'source',
      sourceRowKey: 'row',
      auto: true,
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
            },
            ...(feedback
              ? [
                  {
                    id: 'feedback',
                    kind: 'review' as const,
                    target: 'emp_recipient',
                    recipientId: 'emp_recipient'
                  }
                ]
              : [])
          ]
        },
        {
          id: 'other',
          title: 'Other obligation',
          finish: 'complete',
          dependsOn: [],
          actions: [],
          conditions: [{ id: 'file', kind: 'file', target: join(f.workspace, 'other.txt') }]
        }
      ]
    }
  )
  f.service.dispose()
  for (let index = 0; index < 4; index++) {
    await f.service.tick()
    await f.settle()
  }
  return {
    ...f,
    receipts,
    sentInputs,
    sends: () => sends,
    switchPerson: () => {
      principal = 'different-company:person'
    },
    accept: () => {
      rejecting = false
    }
  }
}

describe('host-owned handoff using real capture and existing delivery engine', () => {
  it('sends a message without files only after the source finishes, once through the same route', async () => {
    const f = await setup(false, false, { working: true, messageOnly: true })
    expect(f.sends()).toBe(0)
    expect(
      (f.service.get('chain').steps[0] as SessionChainHandoffStep).handoff.capturedAt
    ).toBeUndefined()
    vi.mocked(f.runtime.getFreshAgentHookStatusForHandle).mockReturnValue({
      state: 'done',
      lastAssistantMessage: 'Completed',
      interactivePrompt: null,
      stateStartedAt: Date.now(),
      updatedAt: Date.now()
    })
    await f.service.tick()
    await f.service.tick()
    expect(f.sends()).toBe(1)
    expect(f.sentInputs[0]).toMatchObject({
      attachments: [],
      note: 'Review the test deliverable',
      communicationType: 'question',
      recipient: 'emp_recipient'
    })
  })

  it('captures selected files, folders and final history after completion and persists one verified delivery', async () => {
    const f = await setup(false, false, { working: true, history: true, folder: true })
    expect(f.sends()).toBe(0)
    f.write(
      'session.jsonl',
      `${['Before completion', 'Final session answer']
        .map((message) =>
          JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message } })
        )
        .join('\n')}\n`
    )
    vi.mocked(f.runtime.getFreshAgentHookStatusForHandle).mockReturnValue({
      state: 'done',
      lastAssistantMessage: 'Final session answer',
      interactivePrompt: null,
      stateStartedAt: Date.now(),
      updatedAt: Date.now()
    })
    await f.service.tick()
    await f.service.tick()
    expect(f.sends()).toBe(1)
    const sent = f.sentInputs[0]!
    expect(sent.attachments.map((file) => file.name)).toEqual([
      'deliverable.txt',
      'folder.tar.gz',
      // Why both: the readable name ships separately from this assertion, in either order.
      expect.stringMatching(/^(transcript-source-session-|Conversation transcript - )/)
    ])
    expect(Buffer.from(sent.attachments[2]!.contentBase64, 'base64').toString()).toContain(
      'Final session answer'
    )
    const step = f.service.get('chain').steps[0] as SessionChainHandoffStep
    expect(step.handoff.transcriptFile?.sha256).toBe(sent.attachments[2]!.sha256)
    f.write('session.jsonl', 'changed after delivery')
    await f.service.tick()
    expect(f.sends()).toBe(1)
  })
  it('waits for deliverables that are not there yet, keeps the moment the wait began, and sends once they exist', async () => {
    const clock = movableClock()
    const f = await setup(false, false, { missingDeliverable: true })
    const delivery = () =>
      f.service.get('chain').outcomeSet!.outcomes.find((outcome) => outcome.id === 'delivery')!
    expect(delivery()).toMatchObject({
      status: 'blocked',
      block: { class: 'waiting', code: 'handoff-deliverables', wake: 'deliverables' }
    })
    const since = delivery().block!.since
    // The capture is asked again on every pass, and every pass finds the same wait: the block is
    // cleared for the attempt and written back, and that must not restart its clock.
    for (let pass = 0; pass < 5; pass++) {
      clock.advance(60_000)
      await f.service.tick()
      expect(delivery().block).toMatchObject({ code: 'handoff-deliverables', since })
    }
    expect(f.sends()).toBe(0)
    expect(f.service.get('chain').outcomeSet!.attention ?? []).toEqual([])
    expect(
      (f.service.get('chain').steps[0] as SessionChainHandoffStep).handoff.exception
    ).toBeUndefined()

    f.write('deliverable.txt', 'the exact requested file')
    await f.service.tick()
    await f.service.tick()
    expect(f.sends()).toBe(1)
    expect(f.service.get('chain').steps[0]).toMatchObject({ status: 'delivered' })
  })

  it('ends only its own ownership outcome at the supported receipt, and does not resend after replay', async () => {
    const f = await setup(false)
    // A hand off is finished by its verified delivery: the sender is asked for nothing afterwards.
    // The run still reads `failed` for the OTHER obligation, whose file nobody delivered — an
    // honest failure, and never a request either.
    expect(sessionOutcomeProgress(f.service.get('chain').outcomeSet!)).toMatchObject({
      satisfied: 1,
      total: 2,
      phase: 'failed',
      lifecycle: 'waiting',
      attention: []
    })
    expect(f.service.get('chain').outcomeSet!.attention ?? []).toEqual([])
    expect(
      f.service.get('chain').outcomeSet!.outcomes.find((o) => o.id === 'other')!.block
    ).toMatchObject({ class: 'failed', code: 'deliverable-unverified' })
    expect(f.receipts.size).toBe(1)
    expect(f.sends()).toBe(1)
    await f.service.tick()
    await f.service.tick()
    expect(f.sends()).toBe(1)
    const saved = f.service.get('chain').steps[0] as SessionChainHandoffStep
    expect(saved.handoff.files?.[0]?.sha256).toHaveLength(64)
    expect(saved.handoff.recipients[0]?.ownershipTransferredAt).toBeTypeOf('number')
  })
  it('keeps feedback responsibility until actual current-version recipient approval', async () => {
    const f = await setup(true)
    expect(sessionOutcomeProgress(f.service.get('chain').outcomeSet!).satisfied).toBe(0)
    // A person REVIEW waits on the recipient: a registered wake that names them, and their
    // request — never the owner's needs-you.
    const delivery = () =>
      f.service.get('chain').outcomeSet!.outcomes.find((o) => o.id === 'delivery')!
    expect(delivery().block).toMatchObject({
      class: 'waiting',
      code: 'person-review',
      wake: 'Test recipient'
    })
    const waiting = readSessionRun(f.service.get('chain').outcomeSet!)
    expect(waiting).toMatchObject({ phase: 'waiting', wake: 'Test recipient', attention: [] })
    expect(waiting.awaitingOthers).toMatchObject([
      {
        kind: 'review',
        state: 'open',
        recipient: { type: 'person', employeeId: 'emp_recipient', name: 'Test recipient' },
        scope: { outcomeId: 'delivery', conditionId: 'feedback' }
      }
    ])
    const detail = [...f.receipts.values()][0]!
    detail.reviews.push({
      id: 'review_old',
      decision: 'approve',
      version_ids: ['hfv_old'],
      current: false
    })
    await f.service.tick()
    expect(sessionOutcomeProgress(f.service.get('chain').outcomeSet!).satisfied).toBe(0)
    detail.reviews.push({
      id: 'review_current',
      decision: 'approve',
      version_ids: detail.files.map((file) => file.id),
      current: true
    })
    await f.service.tick()
    expect(sessionOutcomeProgress(f.service.get('chain').outcomeSet!).satisfied).toBe(1)
    expect(f.sends()).toBe(1)
    // Their reply is the wake, and it resumes the run exactly once: one receipt, the request met,
    // and nothing re-recorded or re-asked by the passes that follow.
    for (let index = 0; index < 3; index++) {
      await f.service.tick()
    }
    expect(delivery().status).toBe('satisfied')
    expect(delivery().evidence.filter((entry) => entry.conditionId === 'feedback')).toHaveLength(1)
    const after = f.service.get('chain').outcomeSet!
    // Settled by the run itself (met, or withdrawn because its outcome is proven): never left open.
    expect(after.attention).toHaveLength(1)
    expect(after.attention![0]).toMatchObject({ kind: 'review' })
    expect(after.attention![0]!.state).not.toBe('open')
    expect(readSessionRun(after).awaitingOthers).toEqual([])
    expect(f.sends()).toBe(1)
  })
  it('sends a refused handoff again by itself, within a bound, and then fails honestly until a resume', async () => {
    const clock = movableClock()
    const f = await setup(false, true)
    const step = () => f.service.get('chain').steps[0] as SessionChainHandoffStep
    const delivery = () =>
      f.service.get('chain').outcomeSet!.outcomes.find((o) => o.id === 'delivery')!
    const ticks = async (count = 3): Promise<void> => {
      for (let index = 0; index < count; index++) {
        await f.service.tick()
        await f.settle()
      }
    }
    expect(f.sends()).toBe(1)
    expect(step().handoff.recipients[0]?.delivery).toBe('failed')
    expect(delivery().status).toBe('blocked')
    expect(delivery().blockedReason).toContain('roster')
    // Backing off: recovering, with the time of the next send, and nothing leaves meanwhile.
    expect(delivery().block).toMatchObject({ class: 'recovering', code: 'handoff-rejected' })
    expect(delivery().block!.until).toBeTypeOf('number')
    await ticks()
    expect(f.sends()).toBe(1)
    const firstKey = step().handoff.recipients[0]!.operationId

    clock.advance(SESSION_RECOVERY_BACKOFF_MS[0])
    await ticks()
    expect(f.sends()).toBe(2)
    // Refused means never admitted, so the resend carries a fresh key.
    expect(f.sentInputs[1]!.operationId).not.toBe(firstKey)
    await ticks()
    expect(f.sends()).toBe(2)

    clock.advance(SESSION_RECOVERY_BACKOFF_MS[1])
    await ticks()
    expect(f.sends()).toBe(3)
    // The bound is spent: an honest failure, never a request, and nothing more leaves by itself.
    clock.advance(10 * SESSION_RECOVERY_BACKOFF_MS[1])
    await ticks()
    expect(f.sends()).toBe(3)
    expect(delivery().block).toMatchObject({ class: 'failed', code: 'handoff-delivery' })
    expect(f.service.get('chain').outcomeSet!.attention ?? []).toEqual([])
    expect(sessionOutcomeProgress(f.service.get('chain').outcomeSet!)).toMatchObject({
      phase: 'failed',
      lifecycle: 'waiting',
      attention: []
    })

    // A person's Resume lifts the bound once: a fresh key, and this time the hub accepts.
    const spentKey = step().handoff.recipients[0]!.operationId
    f.accept()
    await f.service.resume('chain', f.service.get('chain').outcomeSet!.revision)
    await ticks()
    expect(f.sends()).toBe(4)
    expect(f.sentInputs[3]!.operationId).not.toBe(spentKey)
    expect(step().handoff.recipients[0]?.delivery).toBe('sent')
    expect(step().status).toBe('delivered')
    expect(step().handoff.exception).toBeUndefined()
    expect(delivery().status).toBe('satisfied')
  })

  it('recovers a transient refusal by itself: delivered on the automatic resend, and nobody is asked', async () => {
    const clock = movableClock()
    const f = await setup(false, true)
    const step = () => f.service.get('chain').steps[0] as SessionChainHandoffStep
    expect(f.sends()).toBe(1)
    f.accept()
    clock.advance(SESSION_RECOVERY_BACKOFF_MS[0])
    for (let index = 0; index < 3; index++) {
      await f.service.tick()
      await f.settle()
    }
    expect(f.sends()).toBe(2)
    expect(step().handoff.recipients[0]).toMatchObject({ delivery: 'sent' })
    expect(step().status).toBe('delivered')
    expect(step().handoff.exception).toBeUndefined()
    const set = f.service.get('chain').outcomeSet!
    expect(set.outcomes.find((o) => o.id === 'delivery')!.status).toBe('satisfied')
    expect(set.attention ?? []).toEqual([])
    // No further send once delivered, however much later the host looks again.
    clock.advance(10 * SESSION_RECOVERY_BACKOFF_MS[1])
    await f.service.tick()
    expect(f.sends()).toBe(2)
  })
  it('retains obligations and refuses execution when the signed company/person changes', async () => {
    const f = await setup(true)
    f.switchPerson()
    await f.service.tick()
    expect(sessionOutcomeProgress(f.service.get('chain').outcomeSet!).reasons.join(' ')).toContain(
      'original signed company/person'
    )
    expect(f.sends()).toBe(1)
  })
})
