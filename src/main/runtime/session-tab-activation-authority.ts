/**
 * Who may materialize a terminal surface when a non-host caller (a paired computer or a phone)
 * activates it. Only positive ownership authorizes a process: the owner's current authoritative
 * publication lists the exact tab/leaf (the attached window's, or with no window the persisted
 * session it left), or a runtime-owned binding (serve/SSH, live process) exists. "No window
 * attached" alone proves nothing. Confirmed absence is `tab_not_found`; a publication that is
 * still loading or incomplete is a retryable refusal that keeps the row.
 */

import {
  SESSION_TAB_MOUNT_FAILED_CODE,
  SESSION_TAB_UNVERIFIABLE_CODE,
  sessionTabActivationRefusalMessage,
  type SessionTabActivationRefusalCode,
  type SessionTabActivationRefusalData
} from '../../shared/session-tab-activation-refusal'

export type SessionTabPublicationUnavailableReason =
  /** No window has published yet this run (starting up), or its window object is gone. */
  | 'no-publisher'
  /** The window is reloading. */
  | 'graph-not-ready'
  /** The window has not finished publishing every workspace yet. */
  | 'inventory-not-authoritative'

/** What the owner's current publication says about one workspace (and, when given, one tab). */
export type SessionTabActivationPublication =
  | { kind: 'unavailable'; reason: SessionTabPublicationUnavailableReason }
  /** The attached window's complete publication; an absent workspace is `listed: false`. */
  | { kind: 'window'; listed: boolean }
  /**
   * The persisted workspace session, which is the owner's record with no window: a headless
   * runtime, or a desktop whose window closed while the app runs. Lists the exact tab and leaf.
   */
  | { kind: 'persisted'; listed: boolean }

export type SessionTabActivationEvidence = {
  publication: SessionTabActivationPublication
  /** A connected, runtime-owned PTY backs this surface. */
  liveRuntimeOwned: boolean
  /** The current graph holds a live leaf for this surface (a window or headless pane runs it). */
  liveGraphLeaf: boolean
  /** The window already mounts this surface's leaf, but its process is gone. */
  mountedGraphLeaf: boolean
  /** A live or persisted serve/SSH binding (or a recent expired SSH lease) owns this surface. */
  runtimeOwnedBinding: boolean
  /** The surface already has a streamable handle. */
  surfaceReady: boolean
}

export type SessionTabActivationVerdict =
  /** Attach to what runs; never create. */
  | 'attach'
  /** Positively owned runtime surface: materialize it here. */
  | 'materialize'
  /** The window lists it but it is not running: mount it through the window, acknowledged. */
  | 'mount-in-window'
  /** Confirmed absent from the owner's current authoritative publication. */
  | 'absent'
  /** The publication is unavailable or incomplete: refuse, retryably, and start nothing. */
  | 'unverifiable'

export function classifySessionTabActivation(
  evidence: SessionTabActivationEvidence
): SessionTabActivationVerdict {
  const { publication } = evidence
  if (evidence.liveRuntimeOwned || evidence.liveGraphLeaf) {
    return 'attach'
  }
  if (evidence.surfaceReady) {
    // Why: attaching starts nothing, so only confirmed absence stops it; a stale snapshot alone
    // must not keep a surface the owner's current publication dropped.
    if (evidence.runtimeOwnedBinding || publication.kind === 'unavailable' || publication.listed) {
      return 'attach'
    }
    return 'absent'
  }
  // Why first: a surface the window lists is the window's to mount, even when a serve/SSH binding
  // could be reattached here; only that mount is acknowledged and visible.
  if (publication.kind === 'window' && publication.listed) {
    // Why: a mount request for a leaf the window already mounts starts nothing (a parked pane).
    return evidence.mountedGraphLeaf ? 'materialize' : 'mount-in-window'
  }
  if (evidence.runtimeOwnedBinding) {
    return 'materialize'
  }
  if (publication.kind === 'unavailable') {
    return 'unverifiable'
  }
  return publication.listed ? 'materialize' : 'absent'
}

/** A missing row is absence proof only under a current authoritative publication. */
export function classifyMissingSessionTab(
  publication: SessionTabActivationPublication
): 'absent' | 'unverifiable' {
  return publication.kind === 'unavailable' ? 'unverifiable' : 'absent'
}

export type SessionTabActivationRefusalError = Error & {
  code: SessionTabActivationRefusalCode
  data: SessionTabActivationRefusalData
}

function refusal(
  code: SessionTabActivationRefusalCode,
  reason: string
): SessionTabActivationRefusalError {
  const error = new Error(
    sessionTabActivationRefusalMessage(code)
  ) as SessionTabActivationRefusalError
  error.code = code
  error.data = { retryable: true, reason }
  return error
}

export function sessionTabUnverifiableError(reason: string): SessionTabActivationRefusalError {
  return refusal(SESSION_TAB_UNVERIFIABLE_CODE, reason)
}

export function sessionTabMountFailedError(reason: string): SessionTabActivationRefusalError {
  return refusal(SESSION_TAB_MOUNT_FAILED_CODE, reason)
}

/** Revalidation found the surface already running: answer with it instead of spawning. */
export class SessionTabActivationAttachInstead extends Error {
  constructor() {
    super('session_tab_attach_instead')
    this.name = 'SessionTabActivationAttachInstead'
  }
}

/** Throws the verdict's refusal; returns for verdicts that may proceed. */
export function assertSessionTabActivationAllowed(
  verdict: SessionTabActivationVerdict,
  publication: SessionTabActivationPublication
): void {
  if (verdict === 'absent') {
    throw new Error('tab_not_found')
  }
  if (verdict === 'unverifiable') {
    throw sessionTabUnverifiableError(
      publication.kind === 'unavailable' ? publication.reason : 'unverifiable'
    )
  }
}
