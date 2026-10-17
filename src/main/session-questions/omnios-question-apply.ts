/**
 * Types an answer the person gave on OmniOS into the live pane that asks it, through the window's
 * own question-card send (every question, multi-select, free text, or the card's skip). Only an
 * answer the pane confirmed counts as delivered; anything else is reported back with its reason.
 */

import { listSessionDecisions } from './session-decision-wiring'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { isClaudeAskSelectorOpen } from '../../shared/claude-ask-selector-screen'
import type { AskQuestion } from '../../shared/native-chat-ask-types'
import type {
  SessionManageOmniosAnswerReply,
  SessionManageRendererRequest
} from '../../shared/session-manage-relay'
import { localHostLabel } from '../local-host-label'
import { activeRuntimeSessionHost } from '../session-host/session-host-runtime'
import { readSidebarRows } from '../session-manage/session-manage-runtime-actions'
import { startOmniosQuestionsSync } from './omnios-question-runtime'
import {
  omniosQuestionItems,
  omniosQuestionFingerprint,
  type OmniosApplyOutcome,
  type OmniosQuestionAnswer
} from './omnios-question-sync'

type AnswerRuntime = Pick<
  OrcaRuntimeService,
  'resolveTerminalPane' | 'getFreshAgentHookStatusForHandle' | 'readTerminal'
> & { requestSessionFolders(request: SessionManageRendererRequest): Promise<unknown> }

function refused(error: string): OmniosApplyOutcome {
  return { delivered: false, error: error.slice(0, 400) }
}

const GONE = 'The session is no longer waiting on this question; nothing was typed.'

export function liveDecisionFor(fingerprint: string) {
  return listSessionDecisions({ score: false }).find(
    (decision) => decision.endedAt === null && omniosQuestionFingerprint(decision) === fingerprint
  )
}

function isReply(value: unknown): value is SessionManageOmniosAnswerReply {
  return (
    typeof value === 'object' &&
    value !== null &&
    ((value as { delivered?: unknown }).delivered === true ||
      ((value as { delivered?: unknown }).delivered === false &&
        typeof (value as { error?: unknown }).error === 'string'))
  )
}

/** Whether this host's own copy of the screen shows Claude's selector; null when it cannot tell. */
async function askOnHostScreen(
  runtime: AnswerRuntime,
  terminal: string,
  agent: string | undefined,
  questions: AskQuestion[]
): Promise<boolean | null> {
  if (agent !== 'claude') {
    return null
  }
  try {
    const read = await runtime.readTerminal(terminal, { screen: true })
    return read.source === 'screen'
      ? isClaudeAskSelectorOpen([...read.tail, read.draft ?? ''].join('\n'), { questions })
      : null
  } catch {
    return null
  }
}

export async function applyOmniosAnswer(
  runtime: AnswerRuntime,
  answer: OmniosQuestionAnswer,
  findDecision: (fingerprint: string) => ReturnType<typeof liveDecisionFor> = liveDecisionFor
): Promise<OmniosApplyOutcome> {
  const decision = findDecision(answer.fingerprint)
  if (!decision?.worktreeId || !decision.interactivePrompt) {
    return refused(GONE)
  }
  let terminal: string | null
  try {
    terminal = runtime.resolveTerminalPane(decision.paneKey, decision.worktreeId).handle ?? null
  } catch {
    return refused('The terminal that asked this question is gone; nothing was typed.')
  }
  // Why openAsk: a session waiting on its card reports nothing, however long the person takes.
  const hook = terminal
    ? runtime.getFreshAgentHookStatusForHandle(terminal, { openAsk: true })
    : null
  if (
    !terminal ||
    !hook?.interactivePrompt ||
    hook.interactivePrompt !== decision.interactivePrompt
  ) {
    return refused(GONE)
  }
  // Why the host's screen: an old report is no proof, and the window may not show this pane.
  const onScreen = hook.unconfirmedAsk
    ? await askOnHostScreen(runtime, terminal, hook.agentType, decision.questions)
    : true
  if (onScreen === false) {
    return refused(GONE)
  }
  let reply: unknown
  try {
    reply = await runtime.requestSessionFolders({
      kind: 'answerOmniosQuestion',
      paneKey: decision.paneKey,
      interactivePrompt: decision.interactivePrompt,
      answers: answer.answers,
      skipped: answer.skipped,
      ...(onScreen === null ? { confirmOnScreen: true } : {})
    })
  } catch (error) {
    // Why not "nothing typed": a relay timeout can land after keys went; the person checks.
    return refused(
      `The desktop window did not confirm the answer; check the session before answering again. ${
        error instanceof Error ? error.message : ''
      }`.trim()
    )
  }
  if (!isReply(reply)) {
    return refused('This OmniConsole window cannot type OmniOS answers yet; reload it and retry.')
  }
  return reply.delivered ? { delivered: true } : refused(reply.error)
}

const TITLE_READ_MS = 5_000

/** Starts the OmniOS sync for this runtime; titles come from the sidebar when the panes change. */
export function startOmniosSessionQuestions(runtime: OrcaRuntimeService): () => void {
  const titles = new Map<string, string>()
  let titledPanes = ''
  const list = async () => {
    const decisions = listSessionDecisions({ score: false })
    const panes = decisions
      .filter((decision) => decision.endedAt === null)
      .map((decision) => decision.paneKey)
      .sort()
      .join('\n')
    if (panes && panes !== titledPanes) {
      titledPanes = panes
      // Why bounded: with no window the relay may not answer; titles are a nicety.
      const rows = await Promise.race([
        readSidebarRows(runtime).catch(() => []),
        new Promise<[]>((resolve) => setTimeout(() => resolve([]), TITLE_READ_MS).unref?.())
      ])
      for (const row of rows) {
        if (row.paneKey && row.title) {
          titles.set(row.paneKey, row.title)
        }
      }
    }
    return omniosQuestionItems(
      decisions.map((decision) => ({
        ...decision,
        title: titles.get(decision.paneKey) ?? decision.title
      }))
    )
  }
  return startOmniosQuestionsSync({
    host: localHostLabel(),
    list,
    isPending: (fingerprint) => liveDecisionFor(fingerprint) !== undefined,
    apply: (answer) => applyOmniosAnswer(runtime, answer),
    hostId: () => activeRuntimeSessionHost()?.current()?.identity.hostId
  })
}
