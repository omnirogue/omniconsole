// A session-manage control on a session another computer runs (Phase 4 E): the result has the
// shape the local path answers, the summary says which computer did it, and this Mac audits the
// request it sent (the host audits what it did).

import type {
  SessionManageActionResult,
  SessionManageAnswerResult,
  SessionManageAskResult,
  SessionPromptAnswer
} from '../../../../shared/session-manage-types'
import {
  remoteSessionManage,
  type RemoteManageDone,
  type RemoteManageRequest
} from '../../../session-host-remote/remote-session-manage'
import { getRemoteSessionHosts } from '../../../session-host-remote/remote-session-hosts-runtime'
import type { RpcContext } from '../core'
import type { SessionManageProvenance } from './session-manage-schemas'
import { settleSessionAction, type PreparedSessionAction } from './session-manage-support'

type Params = SessionManageProvenance & { dryRun?: boolean }

async function run(
  prepared: PreparedSessionAction,
  request: RemoteManageRequest,
  params: Params
): Promise<RemoteManageDone | null> {
  return remoteSessionManage({
    hosts: getRemoteSessionHosts(),
    row: prepared.row,
    entry: prepared.entry,
    actor: prepared.actor,
    request,
    provenance: params,
    dryRun: params.dryRun === true
  })
}

function baseResult(
  prepared: PreparedSessionAction,
  request: RemoteManageRequest,
  done: RemoteManageDone
): SessionManageActionResult {
  return {
    dryRun: done.outcome.kind === 'would',
    action: request.action,
    target: { paneKey: prepared.entry.paneKey, title: prepared.entry.title },
    actor: prepared.actor,
    summary: done.summary
  }
}

/** Null for a session this computer runs. */
export async function remoteSessionAction(
  context: Pick<RpcContext, 'runtime'>,
  prepared: PreparedSessionAction,
  request: Exclude<RemoteManageRequest, { action: 'ask' | 'answer' }>,
  params: Params
): Promise<SessionManageActionResult | null> {
  const done = await run(prepared, request, params)
  return done
    ? settleSessionAction(
        context,
        prepared,
        request.action,
        baseResult(prepared, request, done),
        params
      )
    : null
}

export async function remoteSessionAsk(
  context: Pick<RpcContext, 'runtime'>,
  prepared: PreparedSessionAction,
  request: Extract<RemoteManageRequest, { action: 'ask' }>,
  params: Params
): Promise<SessionManageAskResult | null> {
  const done = await run(prepared, request, params)
  if (!done) {
    return null
  }
  const result: SessionManageAskResult = baseResult(prepared, request, done)
  if (done.outcome.kind === 'completed') {
    const reply = done.outcome.operation.result as { outcome?: unknown; reply?: unknown } | null
    if (reply?.outcome === 'answered' && typeof reply.reply === 'string') {
      Object.assign(result, {
        outcome: 'answered',
        reply: reply.reply,
        summary: `“${prepared.entry.title}” answered.`
      })
    } else {
      Object.assign(result, { outcome: 'timeout', question: 'delivered' })
    }
  }
  return settleSessionAction(context, prepared, 'ask', result, params)
}

function chosenOf(
  answer: SessionPromptAnswer,
  options: readonly { n: number; label: string }[]
): SessionManageAnswerResult['chosen'] {
  switch (answer.kind) {
    case 'allow':
      return { label: 'Allow', value: 'allow' }
    case 'deny':
      return { label: 'Deny', value: 'deny' }
    case 'choose':
      return {
        n: answer.choice,
        label:
          options.find((option) => option.n === answer.choice)?.label ?? `option ${answer.choice}`,
        value: String(answer.choice)
      }
    case 'text':
      return { label: answer.text, value: answer.text }
  }
}

export async function remoteSessionAnswer(
  context: Pick<RpcContext, 'runtime'>,
  prepared: PreparedSessionAction,
  request: Extract<RemoteManageRequest, { action: 'answer' }>,
  params: Params
): Promise<SessionManageAnswerResult | null> {
  const done = await run(prepared, request, params)
  if (!done) {
    return null
  }
  // Why this Mac's reading: the host re-checks the fingerprint and refuses a changed question.
  const ask = prepared.entry.ask ?? {
    kind: 'question' as const,
    text: 'The question on the computer that runs it.',
    options: [],
    fingerprint: request.payload.expect
  }
  const result: SessionManageAnswerResult = {
    ...baseResult(prepared, request, done),
    ask,
    commandText: [],
    chosen: chosenOf(request.payload.answer, ask.options),
    delivery:
      done.outcome.kind === 'would'
        ? 'dry-run'
        : done.outcome.kind === 'completed'
          ? 'confirmed'
          : 'unconfirmed'
  }
  return settleSessionAction(context, prepared, 'answer', result, params)
}
