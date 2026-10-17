/**
 * Binds a work item (`jira:<KEY>`) to the conversation in a pane on this computer, or to a routine
 * that already watches it: the conversation id, provider, account home, model, effort and folder
 * OmniOS needs to reopen exactly that conversation later. One owner per item; a re-bind replaces it.
 */

import { launchFacts } from '../artifacts/artifact-review-sleep-arm'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import type { WorkDeliveryApi, WorkOwnerBinding } from './work-delivery-api'

export const JIRA_WORK_KEY = /^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/

export type WorkBindRequest = {
  jira: string
  source: string
  pane?: { paneKey: string; worktreeId: string; title: string }
  routine?: string
  prNumbers?: number[]
}

export type WorkBindResult =
  | { ok: true; workItem: string; binding: WorkOwnerBinding }
  | { ok: false; reason: string }

export async function bindWorkOwner(
  deps: {
    runtime: OrcaRuntimeService
    api: WorkDeliveryApi
    hostId: string | null
    hostLabel: string
  },
  request: WorkBindRequest
): Promise<WorkBindResult> {
  const key = request.jira.trim().toUpperCase()
  if (!JIRA_WORK_KEY.test(key)) {
    return { ok: false, reason: `${request.jira} is not a Jira issue key (like OMR-93).` }
  }
  if (!deps.hostId) {
    return {
      ok: false,
      reason: 'This computer has no session-host identity yet, so nothing can be bound to it.'
    }
  }
  const workItem = `jira:${key}`
  const base = { hostId: deps.hostId, hostLabel: deps.hostLabel, source: request.source }
  let binding: WorkOwnerBinding
  if (request.routine) {
    binding = { ...base, deliverVia: 'routine', routineRef: request.routine }
  } else if (request.pane) {
    const facts = await launchFacts(deps.runtime, request.pane)
    if (typeof facts === 'string') {
      return { ok: false, reason: `It cannot be bound: ${facts}.` }
    }
    const conversationId = deps.runtime.getLastAgentHookRowForPane(request.pane.paneKey)
      ?.providerSession?.id
    if (!conversationId) {
      return {
        ok: false,
        reason: 'Its agent has not reported which conversation it is yet, so it cannot be bound.'
      }
    }
    binding = {
      ...base,
      provider: facts.provider,
      conversationId,
      paneKey: request.pane.paneKey,
      title: request.pane.title,
      ...(facts.accountHome ? { accountId: facts.accountHome } : {}),
      ...(facts.model ? { model: facts.model } : {}),
      ...(facts.effort ? { effort: facts.effort } : {}),
      ...(facts.cwd ? { folder: facts.cwd } : {})
    }
  } else {
    return {
      ok: false,
      reason: 'Name a session (--pane or the calling pane) or a routine (--routine).'
    }
  }
  if (request.prNumbers?.length) {
    binding.prNumbers = request.prNumbers
  }
  const sent = await deps.api.bindOwner(workItem, binding)
  if (sent.status !== 'ok') {
    return {
      ok: false,
      reason: `OmniOS did not record it (${sent.status === 'refused' ? sent.code : sent.status}).`
    }
  }
  return { ok: true, workItem, binding }
}

type Binder = (request: WorkBindRequest) => Promise<WorkBindResult>
let binder: Binder | null = null

/** Set by `installWorkDelivery`; the `work.bind` RPC reaches OmniOS through it. */
export function installWorkBinder<T extends Binder | null>(next: T): T {
  binder = next
  return next
}

export function workBinder(): Binder | null {
  return binder
}
