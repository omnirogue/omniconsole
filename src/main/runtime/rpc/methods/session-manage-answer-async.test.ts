import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({
  rows: vi.fn(),
  stop: vi.fn(() => true),
  pending: new Map<string, unknown>(),
  sources: null as unknown,
  dropped: vi.fn()
}))

vi.mock('../../../session-manage/session-manage-runtime-sources', () => ({
  createRuntimeObserveSources: () => calls.sources
}))
vi.mock('../../../session-manage/session-manage-runtime-actions', () => ({
  readSidebarRows: calls.rows,
  runtimePaneVerifier: () => () => 'manager:pane',
  runtimeDeliveryDeps: () => ({ stopKeepGoing: calls.stop }),
  showSessionManageNotice: vi.fn()
}))
vi.mock('../../../omni-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => '/unused-profile'
}))
vi.mock('../../../session-manage/session-answer-quarantine', () => ({
  PersistentSessionAnswerQuarantine: class {
    has(key: string) {
      return calls.pending.has(key)
    }
    add(key: string, evidence?: unknown) {
      calls.pending.set(key, evidence)
    }
    delete(key: string) {
      calls.pending.delete(key)
    }
  }
}))
vi.mock('../../../session-manage/session-actions-log', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  sessionActionsLogFor: () => ({ append: vi.fn(async () => undefined) })
}))
vi.mock('../../../agent-hooks/server', () => ({
  agentHookServer: { dropAsyncQuestion: calls.dropped }
}))

import { SESSION_MANAGE_ANSWER_METHOD } from './session-manage-answer-method'
import { withSessionAnswerLock } from '../../../session-manage/session-manage-answer'
import {
  agentEvidence,
  agentProcess,
  manageEntry,
  observeSources,
  sidebarRow
} from '../../../session-manage/session-manage-test-fixtures'
import { readRuntimeSessionPrompt } from '../../../session-manage/session-prompt-runtime'
import { readSessionAsyncQuestion } from '../../../session-manage/session-prompt-hook'
import { readSessionAnswerDeparture } from '../../../session-manage/session-answer-departure'
import { answerAgentQuestionWithProof } from '../../agent-question-message-answer'
import {
  noteAsyncQuestionTurnEnded,
  resetAsyncQuestionAnswerClaimsForTests,
  settleAsyncQuestionAnswers
} from '../../async-question-answer-claims'
import {
  recordTerminalKeyboardSubmit,
  resetTerminalKeyboardSubmitsForTests
} from '../../../session-prep/terminal-keyboard-submits'
import { asyncQuestionAnswerQuarantineKey } from '../../../session-manage/session-manage-answer-lock'
import { isWriteFenceOpen, revokeWriteFencesWhere } from '../../conversation-write-fence'
import { GUARDED_WRITE_FENCE_REVOKED } from '../../../pty/guarded-pty-write'

const QUESTION = 'Which ocean do you prefer?'
const envelope = (question: string, askedAt = 500) =>
  JSON.stringify({
    delivery: 'async',
    asyncQuestions: [
      {
        question,
        multiSelect: false,
        options: [{ label: 'Pacific' }, { label: 'Atlantic' }],
        askedAt
      }
    ]
  })
const row = sidebarRow({ paneKey: 'target:pane', agent: 'codex', title: 'Codex worker' })
const manager = sidebarRow({ paneKey: 'manager:pane', title: 'Manager' })
const proof = agentProcess({ agent: 'codex' })

let hook: {
  state: 'done' | 'working' | 'waiting'
  workingMode?: 'monitoring'
  interactivePrompt: string | null
  stateStartedAt: number
  agentPid: number
} = { state: 'done', interactivePrompt: envelope(QUESTION), stateStartedAt: 1_000, agentPid: 200 }
let written: string[] = []
let onPaste: (who: string) => void = () => {}
let onEnter: (who: string) => void = () => {}
let keepGoing = false
let executionHostId = 'local'

const hookRow = () => ({ ...hook, updatedAt: 1_000, lastAssistantMessage: null })

// A model of `sendTerminalAgentPrompt` in the real order (`writeTerminalAgentPrompt`): one queue
// turn; for the paste and again for Enter, beforeWrite, then the reservation, then the fence check
// the owner makes before writing (a refusal writes nothing), then the write and `afterWrite`.
let queue: Promise<unknown> = Promise.resolve()
let proofChecks = 0
let onProof: (check: number) => void = () => {}
const runtime = {
  resolveTerminalPane: () => ({
    handle: 'term_1',
    ptyId: 'pty-1',
    connected: true,
    executionHostId,
    worktreeId: row.worktreeId
  }),
  getTerminalLivenessVerdict: () => null,
  getFreshAgentHookStatusForHandle: () => hookRow(),
  readTerminal: async () => ({ source: 'screen', tail: ['› Ask Codex to do anything'] }),
  assertTerminalAgentProcess: vi.fn(async () => {
    proofChecks += 1
    onProof(proofChecks)
  }),
  readTerminalProcessEvidence: vi.fn(async () => ({ proof, tree: { kind: 'other' } })),
  sendGuardedSessionKey: vi.fn(async () => 'unsupported'),
  sendTerminalAgentPrompt: vi.fn(
    (
      handle: string,
      text: string,
      options: {
        clientMessageId: string
        beforeWrite: (ptyId: string) => Promise<void>
        reserveWrite: (ptyId: string) => void
        afterWrite?: (ptyId: string) => void
        writeFence?: string
      }
    ) => {
      const who = options.clientMessageId.startsWith('session-answer:') ? 'CLI' : 'DESKTOP'
      const write = async (what: string, after: () => void) => {
        await options.beforeWrite('pty-1')
        options.reserveWrite('pty-1')
        if (options.writeFence && !isWriteFenceOpen(options.writeFence)) {
          throw new Error(GUARDED_WRITE_FENCE_REVOKED)
        }
        written.push(`${who}:${what}`)
        options.afterWrite?.('pty-1')
        after()
      }
      const run = async () => {
        await write(`paste(${JSON.stringify(text)})`, () => onPaste(who))
        await Promise.resolve()
        await write('<Enter>', () => onEnter(who))
        return { handle, accepted: true, bytesWritten: text.length }
      }
      const result = queue.then(run, run)
      queue = result.catch(() => {})
      return result
    }
  )
}

const context = {
  runtime: runtime as never,
  orchestrationCompatibilityEvidence: { paneKey: manager.paneKey! }
}

const fingerprint = () =>
  readSessionAsyncQuestion(hookRow(), { handle: 'term_1', ptyId: 'pty-1' })!.ask.fingerprint

function cliAnswer(answer: unknown = { kind: 'choose', choice: 2 }, expect = fingerprint()) {
  const params = SESSION_MANAGE_ANSWER_METHOD.params!.parse({
    target: { paneKey: row.paneKey },
    expect,
    answer,
    reason: 'Sal picked on /work/decisions',
    request: "Sal's pick on its /work/decisions question page"
  })
  return SESSION_MANAGE_ANSWER_METHOD.handler(params, context as never) as Promise<
    Record<string, unknown>
  >
}

const desktopAnswer = (answer = 'Pacific', id = 'card-1') =>
  answerAgentQuestionWithProof(
    runtime as never,
    {
      ptyId: 'pty-1',
      paneKey: 'target:pane',
      text: `> ${QUESTION}\n\n${answer}`,
      clientMessageId: id
    },
    () => {}
  )

async function settle<T>(pending: Promise<T>, ms = 22_000): Promise<T | Error> {
  const caught = pending.catch((error: unknown) => error as Error)
  await vi.advanceTimersByTimeAsync(ms)
  return caught
}

/** Codex takes the answer: its UserPromptSubmit reaches the host, and its row moves on. */
function codexTakesIt(): void {
  settleAsyncQuestionAnswers('target:pane', 'taken')
  hook = { ...hook, state: 'working', interactivePrompt: null, stateStartedAt: 2_000 }
}

beforeEach(async () => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  resetAsyncQuestionAnswerClaimsForTests()
  resetTerminalKeyboardSubmitsForTests()
  calls.pending.clear()
  hook = {
    state: 'done',
    interactivePrompt: envelope(QUESTION),
    stateStartedAt: 1_000,
    agentPid: 200
  }
  written = []
  onPaste = () => {}
  onEnter = () => {}
  keepGoing = true
  executionHostId = 'local'
  queue = Promise.resolve()
  proofChecks = 0
  onProof = () => {}
  calls.rows.mockResolvedValue([row, manager])
  calls.sources = observeSources({
    hook: () => hookRow(),
    titleStatus: () => 'idle',
    evidence: async () =>
      agentEvidence({ foreground: { kind: 'agent', agent: 'codex' }, process: proof }),
    keepGoing: () => keepGoing,
    prompt: (target, handle) => readRuntimeSessionPrompt(runtime as never, target, handle)
  } as never)
  await withSessionAnswerLock(`${row.worktreeId}:${row.paneKey}`, async (lock) => lock.leftPrompt())
})
afterEach(() => vi.useRealTimers())

describe('omni session answer on a Codex async question', () => {
  it('B1: answers the question a finished turn carries, confirmed by Codex’s own report', async () => {
    onEnter = codexTakesIt
    const outcome = await settle(cliAnswer())
    expect(outcome).toMatchObject({ delivery: 'confirmed' })
    expect(written).toEqual([
      `CLI:paste(${JSON.stringify(`> ${QUESTION}\n\nAtlantic`)})`,
      'CLI:<Enter>'
    ])
    expect(calls.stop).toHaveBeenCalledOnce()
    expect(calls.pending.size).toBe(0)
  })

  it('B1: refuses before Keep going or the pending marker changes', async () => {
    // The host's own process reading, taken last, no longer finds Codex in front.
    runtime.readTerminalProcessEvidence.mockResolvedValueOnce({
      proof: null,
      tree: { kind: 'other' }
    } as never)
    const outcome = await settle(cliAnswer())
    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as Error).message).toMatch(/could not be proven/)
    expect((outcome as Error).message).not.toMatch(/Keep going/)
    expect(calls.stop).not.toHaveBeenCalled()
    expect(calls.pending.size).toBe(0)
    expect(written).toEqual([])
  })

  it('also while only its children run, as `session questions` lists it', async () => {
    hook = { ...hook, state: 'working', workingMode: 'monitoring' }
    onEnter = codexTakesIt
    await expect(settle(cliAnswer())).resolves.toMatchObject({ delivery: 'confirmed' })
  })

  it('B2: a paste that landed before its Enter was stopped is never "Nothing was sent"', async () => {
    // A person types in the pane between the paste and Enter: the fence is revoked.
    onPaste = () => revokeWriteFencesWhere(() => true)
    const first = await settle(cliAnswer())
    expect(first).toBeInstanceOf(Error)
    expect((first as Error).message).toMatch(/may already have reached/)
    expect(calls.pending.size).toBe(1)
    onPaste = () => {}
    const second = await settle(cliAnswer())
    expect(second).toBeInstanceOf(Error)
    expect(written.filter((write) => write.includes('paste'))).toHaveLength(1)
  })

  it('B3a: an answer the pane card sent blocks the mirror until Codex reports it', async () => {
    await expect(desktopAnswer()).resolves.toEqual({ status: 'delivered' })
    const mirror = await settle(cliAnswer())
    expect((mirror as Error).message).toMatch(/already on its way/)
    expect(calls.stop).not.toHaveBeenCalled()
    expect(written.filter((write) => write.includes('paste'))).toHaveLength(1)
    // Codex reports the turn the answer started; the same words asked again are a new question.
    codexTakesIt()
    hook = {
      state: 'done',
      interactivePrompt: envelope(QUESTION, 2_500),
      stateStartedAt: 3_000,
      agentPid: 200
    }
    onEnter = codexTakesIt
    await expect(settle(cliAnswer())).resolves.toMatchObject({ delivery: 'confirmed' })
  })

  it('B3b: nothing reaches the composer between an answer’s paste and its Enter', async () => {
    let desktop: Promise<unknown> | null = null
    onPaste = (who) => {
      if (who === 'CLI' && !desktop) {
        desktop = desktopAnswer('Pacific', 'card-2')
      }
    }
    onEnter = codexTakesIt
    const mirror = await settle(cliAnswer())
    expect(mirror).toMatchObject({ delivery: 'confirmed' })
    await expect(desktop).resolves.toMatchObject({ status: 'not-sent' })
    expect(written).toEqual([
      `CLI:paste(${JSON.stringify(`> ${QUESTION}\n\nAtlantic`)})`,
      'CLI:<Enter>'
    ])
  })

  it('M1b: an unconfirmed answer does not close the pane to its next question', async () => {
    // Codex took it but its report never arrived within the window.
    const first = await settle(cliAnswer())
    expect(first).toMatchObject({ delivery: 'unconfirmed' })
    const firstMarker = asyncQuestionAnswerQuarantineKey(
      `${row.worktreeId}:${row.paneKey}`,
      500,
      QUESTION
    )
    expect(calls.pending.has(firstMarker)).toBe(true)
    // Its report arrives; the turn runs and ends on a new question.
    codexTakesIt()
    hook = {
      state: 'done',
      interactivePrompt: envelope('Which sea next?', 8_500),
      stateStartedAt: 9_000,
      agentPid: 200
    }
    onEnter = codexTakesIt
    await expect(settle(cliAnswer({ kind: 'choose', choice: 1 }))).resolves.toMatchObject({
      delivery: 'confirmed'
    })
    // The earlier question is gone, so its marker is too.
    expect(calls.pending.has(firstMarker)).toBe(false)
  })

  it('m1: bounds the whole message before anything changes, and sends a long --text whole', async () => {
    onEnter = codexTakesIt
    const long = await settle(cliAnswer({ kind: 'text', text: 'a'.repeat(3_900) }))
    expect(long).toMatchObject({ delivery: 'confirmed' })
    expect(written[0]!.length).toBeGreaterThan(3_900)
  })

  it('keeps one fingerprint per asking, across finished and children-running', () => {
    const first = fingerprint()
    hook = { ...hook, state: 'working', workingMode: 'monitoring', stateStartedAt: 1_700 }
    expect(fingerprint()).toBe(first)
    hook = { ...hook, state: 'done', interactivePrompt: envelope(QUESTION, 4_000) }
    expect(fingerprint()).not.toBe(first)
  })

  it('SSH: the pane card answers with the relay’s proof; the unattended CLI refuses first', async () => {
    executionHostId = 'ssh:conn-1'
    const outcome = await settle(cliAnswer())
    expect((outcome as Error).message).toMatch(/SSH/)
    expect(calls.stop).not.toHaveBeenCalled()
    expect(written).toEqual([])
    proofChecks = 0
    await expect(desktopAnswer()).resolves.toEqual({ status: 'delivered' })
    const options = runtime.sendTerminalAgentPrompt.mock.calls.at(-1)![2] as Record<string, unknown>
    // No guard at the relay's terminal, so no fence either; each write rests on a fresh proof.
    expect(options.receiver).toBeUndefined()
    expect(options.writeFence).toBeUndefined()
    expect(proofChecks).toBe(3)
  })

  it('B4: a hook report before the first byte leaves no claim and nothing "possibly sent"', async () => {
    hook = { ...hook, state: 'working', workingMode: 'monitoring' }
    // The lead's own report lands while the process is proven for the paste.
    onProof = (check) => {
      if (check === 2) {
        revokeWriteFencesWhere(() => true, 'hook')
      }
    }
    await expect(desktopAnswer('Pacific', 'card-1')).resolves.toMatchObject({ status: 'not-sent' })
    expect(written).toEqual([])
    onProof = () => {}
    await expect(desktopAnswer('Pacific', 'card-2')).resolves.toEqual({ status: 'delivered' })
  })

  it('B4: through omni session answer, nothing typed is "Nothing was sent", with no marker left', async () => {
    onProof = (check) => {
      if (check === 2) {
        revokeWriteFencesWhere(() => true, 'hook')
      }
    }
    const outcome = await settle(cliAnswer())
    expect((outcome as Error).message).toMatch(/Nothing was sent/)
    expect((outcome as Error).message).not.toMatch(/may already have reached/)
    expect(calls.pending.size).toBe(0)
    expect(written).toEqual([])
  })

  it('M2: a child agent’s report does not stop the answer; a child’s approval does', async () => {
    hook = { ...hook, state: 'working', workingMode: 'monitoring' }
    const child = {
      paneKey: 'target:pane',
      toolAgentId: 'child-1',
      payload: {
        state: 'working',
        workingMode: 'monitoring',
        interactivePrompt: hook.interactivePrompt
      }
    }
    onPaste = () => revokeWriteFencesWhere(() => true, 'hook', child)
    await expect(desktopAnswer('Pacific', 'card-1')).resolves.toEqual({ status: 'delivered' })

    resetAsyncQuestionAnswerClaimsForTests()
    written = []
    // A child's approval makes the pane wait: its report stops the Enter.
    onPaste = () =>
      revokeWriteFencesWhere(() => true, 'hook', { ...child, payload: { state: 'waiting' } })
    await expect(desktopAnswer('Pacific', 'card-2')).resolves.toMatchObject({
      status: 'unconfirmed'
    })
    expect(written).toEqual([`DESKTOP:paste(${JSON.stringify(`> ${QUESTION}\n\nPacific`)})`])
  })

  it('M3: an answer typed in Codex’s own box blocks both paths until Codex reports it', async () => {
    noteAsyncQuestionTurnEnded('target:pane', Date.now() - 5_000)
    recordTerminalKeyboardSubmit('pty-1', 'Pacific')
    const mirror = await settle(cliAnswer(), 1_000)
    expect((mirror as Error).message).toMatch(/pressed Enter in its terminal/)
    expect(calls.stop).not.toHaveBeenCalled()
    await expect(desktopAnswer()).resolves.toMatchObject({ status: 'not-sent' })
    expect(written).toEqual([])
    // An Enter that started no turn within a minute submitted nothing.
    await vi.advanceTimersByTimeAsync(61_000)
    await expect(desktopAnswer()).resolves.toEqual({ status: 'delivered' })
  })

  it('M3: an Enter typed while the turn still ran (steering) does not block it', async () => {
    recordTerminalKeyboardSubmit('pty-1', 'also check the tests')
    await vi.advanceTimersByTimeAsync(1_000)
    noteAsyncQuestionTurnEnded('target:pane')
    await expect(desktopAnswer()).resolves.toEqual({ status: 'delivered' })
  })
})

describe('departure after a message answer', () => {
  it('M1: reads the echoed answer as the prompt having left, not as a question', async () => {
    const screen = [
      `› > ${QUESTION}`,
      '',
      '  Atlantic',
      '',
      '• Working (3s • esc to interrupt)',
      '› Ask Codex to do anything'
    ]
    const read = async () => ({
      entry: manageEntry({ state: 'working', stateBasis: 'hook', terminal: 'term_1' }),
      source: { kind: 'pty' as const, paneKey: row.paneKey!, worktreeId: row.worktreeId },
      prompt: undefined
    })
    await expect(
      readSessionAnswerDeparture(
        read as never,
        { readTerminal: async () => ({ source: 'screen', tail: screen }) } as never,
        row
      )
    ).resolves.toEqual({ kind: 'left' })
  })
})
