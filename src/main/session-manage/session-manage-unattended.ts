/**
 * The unattended context (Phase 2, D3/D4/D5): an action no person started. The steward's actor
 * carries it by construction; an automatic cleanup session's pane is registered here by main, so
 * its commands are unattended whatever its pane identity or `--request` says. Only main writes
 * this; a caller can never claim it or shed it. docs/reference/session-steward.md.
 */

import type {
  SessionManageActor,
  SessionManageEntry,
  SessionManageUnattended
} from '../../shared/session-manage-types'
import {
  SESSION_STEWARD_DISABLED_ENV,
  type SessionStewardActMode,
  type SessionStewardFeature
} from '../../shared/session-steward-settings'
import {
  stewardDisabledByEnv,
  stewardFeatureMode,
  stewardSettings
} from '../session-steward/steward-switches'
import { SessionManageRefusal } from './session-manage-refusal'

/** A durable source of automatic runs (WP-S4's run store), asked after the in-memory registry. */
export type UnattendedPaneResolver = (paneKey: string) => SessionManageUnattended | null

const registered = new Map<string, SessionManageUnattended>()
let resolver: UnattendedPaneResolver | null = null

/** An automatic cleanup session's pane; returns the release for when its run is final. */
export function registerUnattendedPane(
  paneKey: string,
  context: SessionManageUnattended
): () => void {
  const entry: SessionManageUnattended = { ...context, since: context.since ?? Date.now() }
  registered.set(paneKey, entry)
  return () => {
    if (registered.get(paneKey) === entry) {
      registered.delete(paneKey)
    }
  }
}

export function setUnattendedPaneResolver(next: UnattendedPaneResolver | null): () => void {
  const previous = resolver
  resolver = next
  return () => {
    resolver = previous
  }
}

export function unattendedPaneContext(
  paneKey: string | null | undefined
): SessionManageUnattended | null {
  if (!paneKey) {
    return null
  }
  const found = registered.get(paneKey)
  if (found || !resolver) {
    return found ?? null
  }
  try {
    return resolver(paneKey)
  } catch {
    // Why fail closed: a run store that cannot answer must not turn a steward run into a person.
    return { source: 'cleanup-run' }
  }
}

function claimedPane(actor: Exclude<SessionManageActor, { kind: 'steward' }>): string | undefined {
  // Why an unproven claim counts here: it can only make the caller more restricted.
  // Why never a remote one: its pane lives on another computer, not in this host's registry.
  return actor.kind === 'pane'
    ? actor.paneKey
    : actor.kind === 'cli'
      ? actor.unverifiedPaneKey
      : undefined
}

/** The caller's actor with its pane's registered context stamped on (`actorFor`). */
export function withUnattendedContext(actor: SessionManageActor): SessionManageActor {
  if (actor.kind === 'steward' || actor.unattended) {
    return actor
  }
  const context = unattendedPaneContext(claimedPane(actor))
  return context ? { ...actor, unattended: context } : actor
}

const accepting = new Map<string, number>()

/**
 * A suggestion the person just said Yes to in Work; its actor reads as person-approved only
 * while this is held. Returns the release for when the accepted action settles.
 */
export function beginSuggestionAcceptance(suggestionId: string): () => void {
  accepting.set(suggestionId, (accepting.get(suggestionId) ?? 0) + 1)
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    const left = (accepting.get(suggestionId) ?? 1) - 1
    if (left > 0) {
      accepting.set(suggestionId, left)
    } else {
      accepting.delete(suggestionId)
    }
  }
}

export function isSuggestionBeingAccepted(suggestionId: string): boolean {
  return accepting.has(suggestionId)
}

/** Null when a person (or an agent acting at the person's request) is behind the actor. */
export function unattendedContextFor(actor: SessionManageActor): SessionManageUnattended | null {
  if (actor.kind === 'steward') {
    if (actor.feature === 'suggestion') {
      // Why fail closed: outside the acceptance the person approved, it is the rules loop.
      return isSuggestionBeingAccepted(actor.suggestionId) ? null : { source: 'rules' }
    }
    return { source: actor.feature, ...(actor.runId ? { runId: actor.runId } : {}) }
  }
  return actor.unattended ?? unattendedPaneContext(claimedPane(actor))
}

/** What an unattended actor tries; each gated action names the switch that allows it. */
export type UnattendedAction =
  | 'yes'
  | 'prompt'
  | 'ask'
  | 'archive'
  /** The blank-session rule's close: the sidebar's Delete, which ends the agent. */
  | 'close'
  | 'handoff'
  | 'consolidate'
  | 'stop'
  | 'restart'
  | 'rename'
  | 'answer'
  | 'assign'
  | 'organize'
  | 'folder-change'
  | 'resume'
  | 'hold'

export type GatedAction = 'yes' | 'prompt' | 'ask' | 'archive' | 'close'
type NeverAction = Exclude<UnattendedAction, GatedAction>

export const SWITCH_OF: Record<GatedAction, SessionStewardFeature> = {
  yes: 'safeYes',
  prompt: 'nudges',
  ask: 'nudges',
  archive: 'tier2Archive',
  close: 'emptySessionArchive'
}

const SWITCH_LABEL: Partial<Record<SessionStewardFeature, string>> = {
  safeYes: 'Say yes to safe next steps',
  nudges: 'Nudge sessions that stopped with work left',
  tier2Archive: 'Archive finished sessions',
  automaticCleanup: 'Clean up when leftovers pile up',
  emptySessionArchive: 'Clean up sessions nobody prompted'
}

const NEEDS_PERSON: Record<NeverAction, string> = {
  handoff: 'hand off a session',
  consolidate: 'merge sessions',
  stop: 'stop a session',
  restart: 'restart a session',
  rename: 'rename a session',
  answer: 'answer a question put to the person',
  assign: 'give a session a new task',
  organize: 'organize sessions in bulk (it archives only through session tidy)',
  'folder-change': 'move, unarchive or delete sessions, or change folders',
  resume: 'reopen a past session',
  // Why: the steward sends when a session is free or not at all; it never leaves prompts waiting.
  hold: 'hold a prompt for a busy session'
}

export const UNATTENDED_MERGE_REFUSAL =
  'Handing off or merging sessions runs only on the person’s yes; a steward run can suggest it, never do it. Nothing changed.'

function isGated(action: UnattendedAction): action is GatedAction {
  return action in SWITCH_OF
}

/** Why a switch keeps the steward from acting now; null when it is on. */
export function stewardSwitchRefusal(feature: SessionStewardFeature): string | null {
  const mode: SessionStewardActMode = stewardFeatureMode(feature)
  if (mode === 'on') {
    return null
  }
  if (stewardDisabledByEnv()) {
    return `The session steward is stopped on this computer (${SESSION_STEWARD_DISABLED_ENV}), so a steward run changes nothing.`
  }
  if (!stewardSettings().enabled) {
    return 'The session steward is switched off in Settings, so a steward run changes nothing.'
  }
  const label = SWITCH_LABEL[feature] ?? feature
  return mode === 'shadow'
    ? `The steward’s “${label}” switch is in shadow mode: it records what it would do and changes nothing.`
    : `The steward’s “${label}” switch is off in Settings, so nothing changed.`
}

/**
 * A steward archive runs under either archive rule (finished, Tier 2; or nobody prompted it), so
 * it is refused here only when both are off; the steward's own check applies each rule's switch.
 */
export function stewardArchiveSwitchRefusal(): string | null {
  const finished = stewardSwitchRefusal('tier2Archive')
  return finished && stewardSwitchRefusal('emptySessionArchive') ? finished : null
}

/**
 * The unattended rules every main-side action runs first; a no-op for anything a person is
 * behind. Throws a refusal (nothing changed) or returns the context the action runs under.
 */
export function assertUnattendedPolicy(
  actor: SessionManageActor,
  action: UnattendedAction,
  target?: Pick<SessionManageEntry, 'title' | 'keepGoing'>
): SessionManageUnattended | null {
  const context = unattendedContextFor(actor)
  if (!context) {
    return null
  }
  // Why: closing ends an agent, so only the rules loop's blank-session rule may do it; a cleanup
  // session's `session delete` still needs the person.
  if (!isGated(action) || (action === 'close' && context.source !== 'rules')) {
    const never: NeverAction = action === 'close' ? 'folder-change' : (action as NeverAction)
    throw new SessionManageRefusal(
      never === 'handoff' || never === 'consolidate'
        ? UNATTENDED_MERGE_REFUSAL
        : `A steward run cannot ${NEEDS_PERSON[never]}; that needs the person. Nothing changed.`
    )
  }
  const off =
    action === 'archive' ? stewardArchiveSwitchRefusal() : stewardSwitchRefusal(SWITCH_OF[action])
  if (off) {
    throw new SessionManageRefusal(off)
  }
  if (action === 'close' && stewardSettings().emptySessionAction !== 'close') {
    throw new SessionManageRefusal(
      'The steward’s blank-session rule is set to archive, not close, so nothing was closed.'
    )
  }
  // Why: any prompt or question turns Keep going off, and the steward never takes over a driver.
  if (target?.keepGoing) {
    throw new SessionManageRefusal(
      `“${target.title}” is driven by Keep going; a steward run never prompts it or turns its Keep going off. Nothing was sent.`
    )
  }
  return context
}
