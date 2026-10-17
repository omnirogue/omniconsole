import { createHash } from 'node:crypto'
import { agentHookServer } from '../../../agent-hooks/server'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { parseAskFromStatus } from '../../../../shared/native-chat-ask'
import type { SessionManageSidebarRow } from '../../../../shared/session-manage-relay'
import type { SessionManageActor } from '../../../../shared/session-manage-types'
import type {
  SessionQuestionOwnerBinding,
  SessionQuestionOwnerReadParams,
  SessionQuestionOwnerReady
} from '../../../../shared/session-question-owner-answer'
import {
  requireExpectedPrompt,
  selectSessionAnswer,
  type SessionAnswerReading
} from '../../../session-manage/session-manage-answer'
import { toSessionManageEntry } from '../../../session-manage/session-manage-inventory'
import { observeSession } from '../../../session-manage/session-manage-observe'
import { SessionManageRefusal } from '../../../session-manage/session-manage-refusal'
import { createRuntimeObserveSources } from '../../../session-manage/session-manage-runtime-sources'
import { remoteControlsOn } from '../../../session-host-owner/session-host-switches'
import type { RpcContext } from '../core'
import { runtimeSessionAnswerDeps } from './session-manage-answer-runtime'

const stale = (): never => {
  throw new SessionManageRefusal(
    'The displayed question or its execution owner changed. Nothing was sent; refresh the question.'
  )
}
const squash = (value: string) => value.replace(/\s+/g, ' ').trim()

/** Headless hosts resolve their own live pane; no sidebar adoption or inventory writes. */
export function questionOwnerRow(
  context: RpcContext,
  params: SessionQuestionOwnerReadParams
): SessionManageSidebarRow {
  const pane = context.runtime.resolveTerminalPane(params.target.paneKey, params.target.worktreeId)
  const incarnation = context.runtime.getTerminalProcessIncarnation(params.target.terminal)
  if (
    context.runtime.getRuntimeId() !== params.runtimeId ||
    context.runtime.getLiveTerminalPaneKey(params.target.terminal) !== params.target.paneKey ||
    !incarnation ||
    incarnation !== context.runtime.getTerminalProcessIncarnation(pane.handle) ||
    pane.worktreeId !== params.target.worktreeId ||
    !pane.connected ||
    !pane.ptyId ||
    parseExecutionHostId(pane.executionHostId)?.kind !== 'local'
  ) {
    stale()
  }
  return {
    rowKey: JSON.stringify(['local', params.target.worktreeId, params.target.paneKey]),
    viewKey: `pane:${params.target.paneKey}`,
    paneKey: params.target.paneKey,
    tabId: pane.tabId,
    kind: 'terminal',
    structuredSessionId: null,
    worktreeId: params.target.worktreeId,
    hostId: 'local',
    hostUnavailable: false,
    title: `${params.displayed.agentType} question`,
    agent: params.displayed.agentType,
    workspace: params.target.worktreeId,
    worktreePath: null,
    repoId: null,
    repoLabel: null,
    branch: null,
    workspaceKind: 'unknown',
    folderId: null,
    folder: null,
    saved: false,
    archived: false,
    archivedByHand: false,
    pinned: false,
    launchPending: false,
    resumable: false,
    shellForeground: false,
    folded: false,
    providerSessionId: params.displayed.providerSession.id
  }
}

function currentHook(context: RpcContext, params: SessionQuestionOwnerReadParams) {
  questionOwnerRow(context, params)
  const hook = context.runtime.getFreshAgentHookStatusForHandle(params.target.terminal)
  const { displayed } = params
  if (
    !hook ||
    hook.interactivePrompt !== displayed.interactivePrompt ||
    hook.stateStartedAt !== displayed.stateStartedAt ||
    hook.agentType !== displayed.agentType ||
    hook.providerSession?.key !== displayed.providerSession.key ||
    hook.providerSession?.id !== displayed.providerSession.id
  ) {
    stale()
  }
  return hook!
}

function questionHookIdentity(
  hook: NonNullable<ReturnType<RpcContext['runtime']['getFreshAgentHookStatusForHandle']>>
) {
  return JSON.stringify([
    hook.state,
    hook.workingMode ?? null,
    hook.interactivePrompt,
    hook.stateStartedAt,
    hook.agentType,
    hook.providerSession?.key,
    hook.providerSession?.id,
    hook.agentPid ?? null,
    hook.sessionBoundary ?? false,
    hook.failed ?? false,
    hook.interrupted ?? false
  ])
}

function questionOccurrence(params: SessionQuestionOwnerReadParams): string {
  const native = parseAskFromStatus(params.displayed.interactivePrompt)
  const askedAt = native?.questions[0]?.askedAt
  if (params.displayed.agentType === 'codex' && native?.delivery === 'async') {
    if (typeof askedAt === 'number' && Number.isFinite(askedAt) && askedAt > 0) {
      return `async:${askedAt}`
    }
  } else {
    const toolUseId = agentHookServer.getToolUseIdForPane(params.target.paneKey)
    if (toolUseId) {
      return `tool:${toolUseId}`
    }
  }
  throw new SessionManageRefusal(
    'The execution host cannot identify this question occurrence. Open its conversation to answer it. Nothing was sent.'
  )
}

export async function readOwnerQuestion(
  context: RpcContext,
  params: SessionQuestionOwnerReadParams,
  actor: SessionManageActor,
  expected?: SessionQuestionOwnerBinding
) {
  const row = questionOwnerRow(context, params)
  const hook = currentHook(context, params)
  const hookIdentity = questionHookIdentity(hook)
  const occurrence = questionOccurrence(params)
  const observed = await observeSession(row, createRuntimeObserveSources(context.runtime))
  const prepared = { row, entry: toSessionManageEntry(observed), source: observed.source, actor }
  const reading: SessionAnswerReading = {
    entry: prepared.entry,
    source: observed.source,
    prompt: observed.prompt,
    agentProcess: observed.agentProcess
  }
  const prompt = requireExpectedPrompt(reading, actor, observed.prompt?.ask.fingerprint ?? '')
  const native = parseAskFromStatus(hook.interactivePrompt)
  const question = native?.questions[0]
  if (
    prompt.ask.kind !== 'question' ||
    !prompt.readable ||
    !question ||
    native?.questions.length !== 1 ||
    question.multiSelect ||
    squash(question.question) !== squash(prompt.subject) ||
    (prompt.delivery.kind !== 'pty' && prompt.delivery.kind !== 'message') ||
    reading.agentProcess?.agent !== params.displayed.agentType ||
    (hook.agentPid !== undefined && hook.agentPid !== reading.agentProcess?.pid)
  ) {
    throw new SessionManageRefusal(
      'This question has no supported, verified single-answer delivery. Open its conversation to answer it. Nothing was sent.'
    )
  }
  const fingerprintFor = (current: SessionAnswerReading) =>
    createHash('sha256')
      .update(
        JSON.stringify([
          'session-question-owner/1',
          context.pairedDeviceId,
          params.runtimeId,
          params.target,
          params.displayed,
          hookIdentity,
          occurrence,
          current.prompt,
          current.agentProcess
        ])
      )
      .digest('hex')
  const binding: SessionQuestionOwnerBinding = {
    runtimeId: params.runtimeId,
    fingerprint: prompt.ask.fingerprint,
    ownerFingerprint: fingerprintFor(reading)
  }
  if (
    expected &&
    (expected.runtimeId !== binding.runtimeId ||
      expected.fingerprint !== binding.fingerprint ||
      expected.ownerFingerprint !== binding.ownerFingerprint)
  ) {
    stale()
  }
  const stillCurrent = () => {
    try {
      context.signal?.throwIfAborted()
      return (
        remoteControlsOn() &&
        questionHookIdentity(currentHook(context, params)) === hookIdentity &&
        questionOccurrence(params) === occurrence
      )
    } catch {
      return false
    }
  }
  const validateReading = (current: SessionAnswerReading) => {
    if (!stillCurrent() || fingerprintFor(current) !== binding.ownerFingerprint) {
      stale()
    }
  }
  validateReading(reading)
  const deps = runtimeSessionAnswerDeps(context, prepared, { validateReading, stillCurrent })
  const options = prompt.ask.options.filter(({ n }) => {
    try {
      const chosen = selectSessionAnswer(
        prompt,
        { kind: 'choose', choice: n },
        actor,
        reading.entry
      )
      deps.validate?.(prompt, chosen)
      return true
    } catch (error) {
      if (error instanceof SessionManageRefusal) {
        return false
      }
      throw error
    }
  })
  const acceptsText = prompt.delivery.kind === 'message'
  if (options.length === 0 && !acceptsText) {
    throw new SessionManageRefusal(
      'This question has no supported answer here. Open its conversation. Nothing was sent.'
    )
  }
  const ready: SessionQuestionOwnerReady = {
    status: 'ready',
    runtimeId: params.runtimeId,
    target: params.target,
    binding,
    question: { text: question.question, options, acceptsText }
  }
  return { ready, prepared, deps }
}
