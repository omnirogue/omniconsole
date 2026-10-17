/**
 * Who is acting, as an execution host decides it: from the authenticated transport plus origin
 * evidence the requesting computer's main process built, never from anything a payload says.
 */

import {
  sessionManageActorTitle,
  sessionManagePromptMarker,
  type SessionManageActor,
  type SessionManageUnattended
} from './session-manage-types'

export type SessionHostUnattended = SessionManageUnattended

/**
 * Built only by the origin computer's main process from its own records (a person's UI surface,
 * a pane's launch evidence), never from CLI flags or agent text. It cannot express `steward`.
 */
export type SessionHostOrigin = {
  /** The origin computer as people know it; part of every `[from …]` marker. */
  computer: string
  requester:
    | { kind: 'person'; via: string }
    | { kind: 'pane'; paneKey: string; title: string; unattended?: SessionHostUnattended }
    | { kind: 'cli'; unattended?: SessionHostUnattended }
  /** The person's own words; audited, never approval (a hard stop still refuses). */
  request?: string
  reason?: string
}

/**
 * One caller type for the host's owner service: its own UI/CLI (`local`), its own steward, or a
 * remote computer over an authenticated transport. Only `remote` arrives over the wire.
 */
export type SessionHostAuthority =
  | { kind: 'local'; actor: Exclude<SessionManageActor, { kind: 'remote' }> }
  | { kind: 'steward'; feature: SessionHostUnattended['source']; runId?: string }
  | {
      kind: 'remote'
      transport: 'paired-runtime' | 'ssh-relay'
      /** The authenticated peer (paired device id, or the relay's owning client). */
      peer: string
      origin: SessionHostOrigin
    }

export const SESSION_HOST_STEWARD_TITLE = 'Session steward'
const PART_MAX = 80

function clean(text: string, fallback: string): string {
  const cleaned = text.replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, PART_MAX)
  return cleaned || fallback
}

export function isUnattendedSessionHostAuthority(authority: SessionHostAuthority): boolean {
  if (authority.kind === 'steward') {
    return true
  }
  if (authority.kind === 'local') {
    // Why a suggestion too: only main's acceptance window makes it the person's (fail closed).
    const { actor } = authority
    return actor.kind === 'steward' || actor.unattended !== undefined
  }
  const { requester } = authority.origin
  return requester.kind !== 'person' && requester.unattended !== undefined
}

/** Who a delivered prompt says it is from, including the computer it came from. */
export function sessionHostActorTitle(authority: SessionHostAuthority): string {
  if (authority.kind === 'local') {
    return sessionManageActorTitle(authority.actor)
  }
  if (authority.kind === 'steward') {
    return SESSION_HOST_STEWARD_TITLE
  }
  const computer = clean(authority.origin.computer, 'another computer')
  const { requester } = authority.origin
  if (isUnattendedSessionHostAuthority(authority)) {
    return `${SESSION_HOST_STEWARD_TITLE} on ${computer}`
  }
  if (requester.kind === 'pane') {
    return `${clean(requester.title, 'another session')} on ${computer}`
  }
  return requester.kind === 'cli' ? `omni CLI on ${computer}` : `person on ${computer}`
}

/** The `[from …] ` marker every delivered message carries. */
export function sessionHostPromptMarker(authority: SessionHostAuthority): string {
  return sessionManagePromptMarker(sessionHostActorTitle(authority))
}
