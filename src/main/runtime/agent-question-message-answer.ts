/**
 * The one host function that writes a message answer to Codex's async question, for the pane card
 * and Needs you (`pty:answerAgentQuestion`) and for `omni session answer`. The question can
 * outlive Codex (it sends no hook on exit), and its answer (`> question`, blank line, answer,
 * Enter) run by a shell truncates a file and executes the answer line. So:
 *
 * - `plan` checks everything and changes nothing: the question is still pending on a finished
 *   turn, its report came from the process that holds the terminal now (by pid), that process is
 *   Codex, and no other answer to it is on its way.
 * - `write` claims the question, then pastes, settles and presses Enter in ONE input-queue turn
 *   (`sendTerminalAgentPrompt`), re-proving the process and the question before each write,
 *   guarded at the PTY owner and under a write fence. A paste left without its Enter is marked an
 *   unresolved draft and reported as possibly delivered, never as "nothing was sent".
 * - `confirm` reads Codex's own report of the turn the answer started, never the screen.
 *
 * SSH: the pane card and Needs you answer with the relay's process proof before each write, as
 * #836 shipped; a relay cannot guard a typed write at its terminal, so there is no fence either.
 * `omni session answer`, which runs unattended for the mirror, refuses SSH.
 */

import {
  asyncAskPendingInStatus,
  questionsQuotedByMessage,
  quotedQuestionLine
} from '../../shared/codex-async-question'
import { parseExecutionHostId } from '../../shared/execution-host'
import { parseAskFromStatus } from '../../shared/native-chat-ask'
import {
  AGENT_QUESTION_ANSWER_MAX_CHARS,
  type AgentQuestionAnswerOutcome,
  type AgentQuestionAnswerRequest
} from '../../shared/agent-question-answer-contract'
import type { TerminalAgentProcessProof } from '../../shared/pty-agent-process-evidence'
import type { ShownAsyncQuestion } from '../../shared/codex-async-question-dismissal'
import {
  childReportKeepsQuestions,
  personMayHaveAnswered,
  writeRefusedWholly
} from './agent-question-answer-guards'
import {
  asyncQuestionAnswerClaimed,
  asyncQuestionAnswerTaken,
  claimAsyncQuestionAnswer,
  holdsAsyncQuestionAnswer,
  releaseAsyncQuestionAnswer
} from './async-question-answer-claims'
import { closeWriteFence, openWriteFence } from './conversation-write-fence'
import type { OrcaRuntimeService } from './omni-runtime'

export type AgentQuestionAnswerRuntime = Pick<
  OrcaRuntimeService,
  | 'resolveTerminalPane'
  | 'getFreshAgentHookStatusForHandle'
  | 'readTerminalProcessEvidence'
  | 'assertTerminalAgentProcess'
  | 'sendTerminalAgentPrompt'
>

/** Codex runs its prompt hooks before OmniConsole hears the new turn: over 8 s measured live. */
export const AGENT_QUESTION_ANSWER_CONFIRM_MS = 20_000

/** Only Codex asks async questions. */
const ASKING_AGENT = 'codex'

const NOT_SENT = 'Nothing was sent.'
const NOT_PROVEN = `Codex could not be proven to hold this terminal. ${NOT_SENT} Answer it in the terminal.`
const MOVED_ON = `That question was already answered, or the session moved on. ${NOT_SENT}`
const ON_ITS_WAY = `An answer to that question is already on its way to Codex. ${NOT_SENT}`
const AGENT_GONE = `Codex is no longer running in this terminal, so its question was removed. ${NOT_SENT}`
const SSH_REFUSED = `This session runs over SSH, where an unattended answer cannot be guarded at its terminal. ${NOT_SENT} Answer it in OmniConsole or in the terminal.`
const PERSON_ANSWERED = `Someone pressed Enter in its terminal after Codex left this question waiting, and Codex has not reported that turn yet; it may already be answered. ${NOT_SENT}`

export type AgentQuestionAnswerPlan = {
  paneKey: string
  worktreeId: string
  handle: string
  ptyId: string
  proof: TerminalAgentProcessProof
  /** The questions this message answers, as its `> question` lines quote them. */
  questions: string[]
  /** Questions its card showed and skipped; dismissed once Codex reports taking the answer. */
  leftOut: readonly ShownAsyncQuestion[]
  /** A local terminal: its owner guards each write and a fence stands over the answer. */
  guarded: boolean
}

type Hook = NonNullable<ReturnType<AgentQuestionAnswerRuntime['getFreshAgentHookStatusForHandle']>>

/** Why this text may not be typed as an answer, or null. Checked before anything changes. */
export function agentQuestionAnswerTextRefusal(text: string): string | null {
  if (!text.trim()) {
    return `The answer is empty. ${NOT_SENT}`
  }
  if (text.length > AGENT_QUESTION_ANSWER_MAX_CHARS) {
    return `The answer is longer than ${AGENT_QUESTION_ANSWER_MAX_CHARS} characters. ${NOT_SENT}`
  }
  for (const character of text) {
    const code = character.charCodeAt(0)
    // Why C1 too: 0x9b is a one-byte CSI to many terminals.
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || (code >= 127 && code < 160)) {
      return `The answer carries terminal control characters. ${NOT_SENT}`
    }
  }
  return null
}

/** The hook's async questions still pending on a finished turn reported by `pid`, or null. */
function pendingQuestions(hook: Hook | null, pid: number): string[] | null {
  const ask = hook ? parseAskFromStatus(hook.interactivePrompt) : null
  if (!hook || ask?.delivery !== 'async' || !asyncAskPendingInStatus(hook, 'async')) {
    return null
  }
  // Why the pid: a report from an earlier Codex (a restored row) is not this process's question.
  return hook.agentPid === pid ? ask.questions.map((question) => question.question) : null
}

/** Every question this answer is for is still pending, reported by the proven process. */
function stillAsks(runtime: AgentQuestionAnswerRuntime, plan: AgentQuestionAnswerPlan): boolean {
  const pending = pendingQuestions(
    runtime.getFreshAgentHookStatusForHandle(plan.handle),
    plan.proof.pid
  )
  const lines = new Set((pending ?? []).map(quotedQuestionLine))
  return pending !== null && plan.questions.every((question) => lines.has(question))
}

export async function planAgentQuestionAnswer(
  runtime: AgentQuestionAnswerRuntime,
  request: Pick<AgentQuestionAnswerRequest, 'paneKey' | 'ptyId' | 'text' | 'leftOut'>,
  options: {
    /** The process `omni session answer` already checked this prompt against. */
    expected?: TerminalAgentProcessProof | null
    onAgentGone?: (paneKey: string) => void
    /** `relay-proof` for a person at the pane card or Needs you; unattended callers refuse. */
    ssh: 'refuse' | 'relay-proof'
  }
): Promise<{ plan: AgentQuestionAnswerPlan } | { refusal: string }> {
  const refused = agentQuestionAnswerTextRefusal(request.text)
  if (refused) {
    return { refusal: refused }
  }
  let pane: ReturnType<AgentQuestionAnswerRuntime['resolveTerminalPane']>
  try {
    pane = runtime.resolveTerminalPane(request.paneKey)
  } catch {
    return { refusal: `Its terminal is no longer open. ${NOT_SENT}` }
  }
  if (!pane.connected || pane.ptyId !== request.ptyId) {
    return { refusal: `Its terminal was replaced. ${NOT_SENT}` }
  }
  const host = parseExecutionHostId(pane.executionHostId)?.kind
  if (host === 'ssh' && options.ssh !== 'relay-proof') {
    return { refusal: SSH_REFUSED }
  }
  if (host !== 'local' && host !== 'ssh') {
    return { refusal: NOT_PROVEN }
  }
  const hook = runtime.getFreshAgentHookStatusForHandle(pane.handle)
  const offered = hook ? parseAskFromStatus(hook.interactivePrompt) : null
  if (!hook || offered?.delivery !== 'async' || !asyncAskPendingInStatus(hook, 'async')) {
    return { refusal: MOVED_ON }
  }
  const questions = questionsQuotedByMessage(
    offered.questions.map((question) => question.question),
    request.text
  )
  if (questions.length === 0) {
    return { refusal: MOVED_ON }
  }
  if (questions.some((question) => asyncQuestionAnswerClaimed(request.paneKey, question))) {
    return { refusal: ON_ITS_WAY }
  }
  if (personMayHaveAnswered(request.paneKey, request.ptyId, hook.stateStartedAt)) {
    return { refusal: PERSON_ANSWERED }
  }
  const evidence = await runtime.readTerminalProcessEvidence(pane.handle).catch(() => null)
  const proof = evidence?.proof
  if (!proof) {
    // Why only on positive evidence: an unreadable host proves nothing about the agent.
    if (evidence?.tree.kind === 'agent-gone') {
      options.onAgentGone?.(request.paneKey)
      return { refusal: AGENT_GONE }
    }
    return { refusal: NOT_PROVEN }
  }
  const expected = options.expected
  if (
    proof.agent !== ASKING_AGENT ||
    proof.ptyId !== request.ptyId ||
    hook.agentPid !== proof.pid ||
    (expected &&
      (expected.pid !== proof.pid ||
        expected.startTimeMs !== proof.startTimeMs ||
        expected.incarnationId !== proof.incarnationId))
  ) {
    return { refusal: NOT_PROVEN }
  }
  try {
    await runtime.assertTerminalAgentProcess(proof, request.ptyId)
  } catch {
    return { refusal: NOT_PROVEN }
  }
  return {
    plan: {
      paneKey: request.paneKey,
      worktreeId: pane.worktreeId ?? '',
      handle: pane.handle,
      ptyId: request.ptyId,
      proof,
      questions,
      leftOut: request.leftOut ?? [],
      guarded: host === 'local'
    }
  }
}

function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  // Why: a bare wire code (`terminal_handle_stale`) is not words the person can act on.
  return !message
    ? NOT_PROVEN
    : /\s/.test(message)
      ? message
      : `The terminal refused it (${message}).`
}

export async function writeAgentQuestionAnswer(
  runtime: AgentQuestionAnswerRuntime,
  plan: AgentQuestionAnswerPlan,
  text: string,
  clientMessageId: string,
  signal?: AbortSignal,
  ownerStillCurrent?: () => boolean
): Promise<AgentQuestionAnswerOutcome> {
  if (ownerStillCurrent && !ownerStillCurrent()) {
    return { status: 'not-sent', reason: MOVED_ON }
  }
  if (!claimAsyncQuestionAnswer(plan.paneKey, plan.questions, clientMessageId, plan.leftOut)) {
    return { status: 'not-sent', reason: ON_ITS_WAY }
  }
  const source = { kind: 'pty' as const, worktreeId: plan.worktreeId, paneKey: plan.paneKey }
  const fence = plan.guarded
    ? openWriteFence(source, () => (ownerStillCurrent?.() ?? true) && stillAsks(runtime, plan), {
        toleratesHookReport: (report) => childReportKeepsQuestions(report, plan.questions)
      })
    : null
  // Why two flags: only bytes that landed make an answer "possibly delivered"; a write refused
  // after its reservation (the fence, the receiver check) wrote nothing.
  let writing = false
  let landed = false
  try {
    await runtime.sendTerminalAgentPrompt(plan.handle, text, {
      clientMessageId,
      beforeWrite: async (ptyId) => {
        const hook = runtime.getFreshAgentHookStatusForHandle(plan.handle)
        if (
          ptyId !== plan.ptyId ||
          !(ownerStillCurrent?.() ?? true) ||
          !holdsAsyncQuestionAnswer(plan.paneKey, clientMessageId) ||
          !stillAsks(runtime, plan)
        ) {
          throw new Error(MOVED_ON)
        }
        if (personMayHaveAnswered(plan.paneKey, ptyId, hook?.stateStartedAt ?? 0)) {
          throw new Error(PERSON_ANSWERED)
        }
        await runtime.assertTerminalAgentProcess(plan.proof, ptyId)
      },
      reserveWrite: () => {
        if (ownerStillCurrent && !ownerStillCurrent()) {
          throw new Error(MOVED_ON)
        }
        writing = true
      },
      afterWrite: () => {
        landed = true
        writing = false
      },
      ...(fence ? { receiver: plan.proof, writeFence: fence } : {}),
      ...(signal ? { signal } : {})
    })
    return { status: 'delivered' }
  } catch (error) {
    if (!landed && (!writing || writeRefusedWholly(error))) {
      releaseAsyncQuestionAnswer(plan.paneKey, clientMessageId)
      const reason = reasonOf(error)
      return {
        status: 'not-sent',
        reason: reason.includes(NOT_SENT) ? reason : `${reason} ${NOT_SENT}`
      }
    }
    // Why kept claimed: some of it reached the terminal; a second copy would answer twice.
    return { status: 'unconfirmed', reason: reasonOf(error) }
  } finally {
    if (fence) {
      closeWriteFence(fence)
    }
  }
}

/** Codex's own evidence that it took the answer: it reported that turn, or dropped the question. */
export async function confirmAgentQuestionAnswer(
  runtime: AgentQuestionAnswerRuntime,
  plan: AgentQuestionAnswerPlan,
  clientMessageId: string,
  windowMs = AGENT_QUESTION_ANSWER_CONFIRM_MS
): Promise<{ status: 'confirmed' } | { status: 'unconfirmed'; reason: string }> {
  const deadline = Date.now() + windowMs
  for (;;) {
    if (asyncQuestionAnswerTaken(clientMessageId)) {
      return { status: 'confirmed' }
    }
    const hook = runtime.getFreshAgentHookStatusForHandle(plan.handle)
    const offered = hook ? parseAskFromStatus(hook.interactivePrompt) : null
    const lines = new Set(
      offered?.delivery === 'async'
        ? offered.questions.map((question) => quotedQuestionLine(question.question))
        : []
    )
    // Why not while waiting: a child's prompt hides the question without Codex having taken it.
    const hidden = hook?.state === 'waiting' || hook?.state === 'blocked'
    if (hook && !hidden && !plan.questions.some((question) => lines.has(question))) {
      return { status: 'confirmed' }
    }
    if (Date.now() >= deadline) {
      return {
        status: 'unconfirmed',
        reason: `Codex did not report taking it within ${Math.round(windowMs / 1000)} seconds`
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

/** The pane card's and Needs you's door: plan, then write. */
export async function answerAgentQuestionWithProof(
  runtime: AgentQuestionAnswerRuntime,
  request: AgentQuestionAnswerRequest,
  onAgentGone: (paneKey: string) => void
): Promise<AgentQuestionAnswerOutcome> {
  const planned = await planAgentQuestionAnswer(runtime, request, {
    onAgentGone,
    ssh: 'relay-proof'
  })
  return 'refusal' in planned
    ? { status: 'not-sent', reason: planned.refusal }
    : await writeAgentQuestionAnswer(runtime, planned.plan, request.text, request.clientMessageId)
}
