/**
 * `omni session resume --ref`: bring a found conversation back on this computer. A row that still
 * holds it answers first (already open, or its exited pane resumes from its checkpoint as
 * `session restart` does); a conversation whose tab was closed reopens from its transcript in a
 * new tab, in the folder it ran in and under the profile its transcript lives in, through the
 * same agent-session resume the app uses. It succeeds only once the new pane's agent itself
 * reports this conversation: a fresh conversation in its place is a failure, never a resume.
 */

import type { SessionAgentTemplate } from '../../shared/session-agent-template'
import type {
  SessionManageConversationOrganization,
  SessionManageSidebarRow
} from '../../shared/session-manage-relay'
import {
  sessionManageActorTitle,
  type SessionManageActionResult,
  type SessionManageActor,
  type SessionManageEntry
} from '../../shared/session-manage-types'
import {
  parseSessionReference,
  rowsForSessionReference,
  type SessionReference
} from '../../shared/session-reference'
import { buildConversationResumeCommand } from '../../shared/conversation-resume-command'
import type { SessionResumeResult } from '../../shared/session-resume-types'
import { SessionManagePartialError, SessionManageRefusal } from './session-manage-refusal'
import type { LocatedTranscript } from './session-transcript-locate'
import { relocatedAwayRefusal } from '../session-host-owner/session-host-relocated-away'
import {
  restoreRemovedForResume,
  type SessionResumeRestore,
  type SessionResumeRestoreApproval
} from './session-manage-resume-restore'

export type SessionResumeLaunch = {
  terminal: string
  tabId: string | null
  paneKey: string | null
  disposition: 'created' | 'adopted'
}

export type SessionResumeVerdict =
  | { state: 'same'; paneKey: string }
  | { state: 'different'; reported: string }
  | { state: 'unconfirmed' }

export type SessionResumeDeps = SessionResumeRestore & {
  readRows(): Promise<SessionManageSidebarRow[]>
  observe(row: SessionManageSidebarRow): Promise<SessionManageEntry>
  /** How the window files the conversation; null when it could not say. */
  organization(reference: SessionReference): Promise<SessionManageConversationOrganization | null>
  locate(reference: SessionReference): Promise<LocatedTranscript[]>
  transcriptCwd(reference: SessionReference, path: string): Promise<string | null>
  /** `session restart` on an exited row with a checkpoint. */
  restart(
    row: SessionManageSidebarRow,
    entry: SessionManageEntry
  ): Promise<SessionManageActionResult>
  launch(input: {
    reference: SessionReference
    transcriptPath: string
    cwd: string
    /** Set only for a non-default profile; the default resumes without a variable. */
    providerRoot: string | null
    /** The held row's launch record, carried onto the new tab. */
    agentTemplate?: SessionAgentTemplate
  }): Promise<SessionResumeLaunch>
  /** Waits for the new pane's agent to report which conversation it opened. */
  confirm(reference: SessionReference, launched: SessionResumeLaunch): Promise<SessionResumeVerdict>
  platform: NodeJS.Platform
  hostLabel: string
  /** Set by callers that reopen work on someone's behalf: an archived conversation comes back out. */
  unarchive?(target: { paneKey: string | null; tabId: string | null }): Promise<void>
}

/** Thrown by `launch` when the transcript's folder is not a workspace this app has open. */
export class SessionResumeWorkspaceMissing extends Error {}

function refuse(message: string): never {
  throw new SessionManageRefusal(`${message} Nothing changed.`)
}

function byHand(
  reference: SessionReference,
  transcriptPath: string,
  cwd: string | null,
  deps: SessionResumeDeps
): string {
  return buildConversationResumeCommand({
    agent: reference.agent,
    sessionId: reference.sessionId,
    cwd,
    transcriptPath,
    executionHostId: reference.hostId,
    hostLabel: deps.hostLabel,
    platform: deps.platform
  }).command
}

/** A row still holds it: open means nothing to do, exited with a checkpoint resumes there. */
async function resumeHeldRow(
  deps: SessionResumeDeps,
  input: { actor: SessionManageActor; ref: string; dryRun: boolean },
  row: SessionManageSidebarRow
): Promise<SessionResumeResult | null> {
  const entry = await deps.observe(row)
  const name = `“${entry.title}”`
  const base = {
    dryRun: input.dryRun,
    action: 'resume' as const,
    target: { paneKey: entry.paneKey, title: entry.title },
    actor: input.actor,
    ref: input.ref,
    paneKey: entry.paneKey,
    tabId: entry.tabId
  }
  if (entry.verdict === 'unverifiable' || (entry.verdict === 'live' && entry.state === 'unknown')) {
    refuse(
      `${name} (pane ${entry.paneKey}) cannot be verified (${entry.waitingOn ?? 'its host is not reachable'}), and a conversation that may still be running is never opened a second time.`
    )
  }
  if (entry.verdict === 'live') {
    return {
      ...base,
      outcome: 'already-open',
      summary: `${name} is already open in pane ${entry.paneKey} (${entry.state}); nothing to resume.`
    }
  }
  if (!row.resumable) {
    return null
  }
  if (input.dryRun) {
    return {
      ...base,
      summary: `Would resume ${name} from its checkpoint in pane ${entry.paneKey}, the same conversation in a new tab (dry run: nothing changed).`
    }
  }
  const restarted = await deps.restart(row, entry)
  const unarchived = row.archived && (await unarchiveResumed(deps, entry))
  return {
    ...base,
    outcome: 'restarted',
    summary: `${restarted.summary}${unarchived ? ' It was archived, so it was unarchived.' : ''}`
  }
}

async function unarchiveResumed(
  deps: SessionResumeDeps,
  target: { paneKey: string | null; tabId: string | null }
): Promise<boolean> {
  if (!deps.unarchive || (!target.paneKey && !target.tabId)) {
    return false
  }
  // Why swallow: the conversation is open either way; the note says it stayed archived.
  return deps.unarchive(target).then(
    () => true,
    () => false
  )
}

export async function resumeConversation(
  deps: SessionResumeDeps,
  input: {
    actor: SessionManageActor
    ref: string
    dryRun: boolean
    restoreDeleted?: SessionResumeRestoreApproval
  }
): Promise<SessionResumeResult> {
  const reference = parseSessionReference(input.ref)
  if (!reference) {
    refuse(
      `${input.ref} is not a session reference (<claude|codex>:<id>@<host>, from omni session search).`
    )
  }
  if (reference.hostId !== 'local') {
    refuse(
      `${input.ref} lives on ${reference.hostId}, not this computer. Resuming a conversation on another computer or an SSH host is not supported yet: resume it on that computer.`
    )
  }
  const away = relocatedAwayRefusal(reference)
  if (away) {
    throw new SessionManageRefusal(away)
  }
  const held = rowsForSessionReference(
    reference,
    (await deps.readRows()).filter((row) => !row.folded && row.paneKey !== null)
  )
  if (held.length > 1) {
    refuse(
      `${input.ref} is held by ${held.length} sidebar rows (${held.map((row) => `pane ${row.paneKey}`).join(', ')}); name one with omni session restart --pane.`
    )
  }
  if (held.length === 1) {
    const resumed = await resumeHeldRow(deps, input, held[0]!)
    if (resumed) {
      return resumed
    }
  }
  const organization = await deps.organization(reference)
  if (!organization) {
    refuse(
      'The window could not say whether the person deleted or hid this conversation, so it was not reopened.'
    )
  }
  await restoreRemovedForResume(deps, reference, organization, input)
  const located = await deps.locate(reference)
  if (located.length === 0) {
    refuse(
      `No transcript for ${input.ref} was found on this computer (source missing), so it cannot be resumed.`
    )
  }
  if (located.length > 1) {
    refuse(
      `${input.ref} has ${located.length} transcripts (${located.map((entry) => entry.path).join(', ')}), so which account or folder it belongs to is ambiguous.`
    )
  }
  const transcript = located[0]!
  const cwd = await deps.transcriptCwd(reference, transcript.path)
  const manual = byHand(reference, transcript.path, cwd, deps)
  if (!cwd) {
    refuse(
      `Its transcript does not record the folder it ran in, so it cannot be reopened here. By hand: ${manual}`
    )
  }
  const profile = {
    variable:
      reference.agent === 'claude' ? ('CLAUDE_CONFIG_DIR' as const) : ('CODEX_HOME' as const),
    path: transcript.providerRoot,
    isDefault: transcript.defaultRoot
  }
  const actorTitle = sessionManageActorTitle(input.actor)
  const base = {
    dryRun: input.dryRun,
    action: 'resume' as const,
    target: { paneKey: null, title: input.ref },
    actor: input.actor,
    ref: input.ref,
    cwd,
    profile
  }
  const under = transcript.defaultRoot
    ? 'its default profile'
    : `the profile ${transcript.providerRoot}`
  // Why say so: a plain resume never unarchives, so its tab opens under Archived.
  const archivedNote = (unarchived: boolean) =>
    !organization.archiveKind
      ? ''
      : unarchived
        ? ' It was archived, so it was unarchived.'
        : organization.archiveKind
          ? ` It stays under Archived (${organization.archiveKind === 'automatic' ? 'filed automatically' : 'by hand'}): omni session archive --ref ${input.ref} --unarchive brings it back.`
          : ''
  if (input.dryRun) {
    return {
      ...base,
      summary: `Would reopen ${input.ref} in a new tab in ${cwd}, under ${under} (dry run: nothing changed).`
    }
  }
  // Why the resume record: the held row's agent has exited, so its live record reads none.
  const heldTemplate = held[0]?.resumeAgentTemplate ?? held[0]?.agentTemplate
  let launched: SessionResumeLaunch
  try {
    launched = await deps.launch({
      reference,
      transcriptPath: transcript.path,
      cwd,
      providerRoot: transcript.defaultRoot ? null : transcript.providerRoot,
      ...(heldTemplate ? { agentTemplate: heldTemplate } : {})
    })
  } catch (error) {
    if (error instanceof SessionResumeWorkspaceMissing) {
      refuse(
        `Its folder ${cwd} is not a workspace OmniConsole has open, so it cannot be reopened here. Add the folder, or resume it by hand: ${manual}`
      )
    }
    throw error
  }
  const done = `a terminal ${launched.terminal} was started in ${cwd}`
  if (launched.disposition === 'adopted') {
    const unarchived =
      !!organization.archiveKind &&
      (await unarchiveResumed(deps, { paneKey: launched.paneKey, tabId: launched.tabId }))
    return {
      ...base,
      outcome: 'adopted',
      target: { paneKey: launched.paneKey, title: input.ref },
      paneKey: launched.paneKey,
      tabId: launched.tabId,
      terminal: launched.terminal,
      summary: `${input.ref} was already running in terminal ${launched.terminal}, so ${actorTitle} did not start a second copy.${archivedNote(unarchived)}`
    }
  }
  const verdict = await deps.confirm(reference, launched)
  if (verdict.state === 'different') {
    throw new SessionManagePartialError(
      `The new terminal opened a different conversation (${verdict.reported}) instead of resuming ${input.ref}; it was left open for the person to check, and nothing was sent to it.`,
      done
    )
  }
  if (verdict.state === 'unconfirmed') {
    throw new SessionManagePartialError(
      `The new terminal's agent did not report which conversation it opened, so resuming ${input.ref} is unconfirmed; check that tab before sending it anything.`,
      done
    )
  }
  const unarchived =
    !!organization.archiveKind &&
    (await unarchiveResumed(deps, { paneKey: verdict.paneKey, tabId: launched.tabId }))
  return {
    ...base,
    outcome: 'resumed',
    target: { paneKey: verdict.paneKey, title: input.ref },
    paneKey: verdict.paneKey,
    tabId: launched.tabId,
    terminal: launched.terminal,
    summary: `${actorTitle} reopened ${input.ref} in a new tab (pane ${verdict.paneKey}) in ${cwd}, under ${under}: the same conversation, confirmed by its agent.${archivedNote(unarchived)}`
  }
}
