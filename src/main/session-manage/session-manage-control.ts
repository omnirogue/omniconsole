import type { LaunchCause } from '../../shared/launch-cause'
/**
 * `omni session stop|restart|rename`. Stop and restart never act on a session whose state or
 * execution cannot be verified; a chat-view (structured) conversation is stopped and resumed from
 * its own tab in this stage, so both refuse it and say so.
 */

import { parseExecutionHostId } from '../../shared/execution-host'
import type { TerminalAgentProcessProof } from '../runtime/terminal-agent-process'
import type { ConversationSource } from '../../shared/conversation-source'
import {
  sessionManageActorTitle,
  type SessionManageActionResult,
  type SessionManageActor,
  type SessionManageEntry
} from '../../shared/session-manage-types'
import type {
  SessionManageRenameReply,
  SessionManageResumeReply,
  SessionManageSidebarRow
} from '../../shared/session-manage-relay'
import type {
  OrganizationRelayedChange,
  OrganizationRelayedOutcome
} from '../../shared/session-organization-change'
import { isSelfTarget } from './session-manage-caller'
import { remoteExecutionRefusal } from './session-manage-locality'
import { afterApplied, SessionManageRefusal } from './session-manage-refusal'
import { assertUnattendedPolicy } from './session-manage-unattended'
import { relocatedAwayRefusal } from '../session-host-owner/session-host-relocated-away'

/** Working with no terminal output for this long reads as hung (agent TUIs animate while busy). */
export const SESSION_HUNG_AFTER_MS = 10 * 60_000
const HUNG_RECOVERY_WAIT_MS = 15_000
const HUNG_RECOVERY_POLL_MS = 1_000

export type SessionControlDeps = {
  interrupt(
    handle: string,
    receiver: TerminalAgentProcessProof,
    source: ConversationSource
  ): Promise<void>
  stopKeepGoing(source: ConversationSource, detail: string): boolean
  lastOutputAt(handle: string): Promise<number | null>
  /** Re-read after an interrupt: is the agent still in its turn? */
  stillWorking(handle: string, receiver: TerminalAgentProcessProof): Promise<boolean>
  resume(
    target: { paneKey?: string; tabId?: string; onlySleptPane?: true },
    launchCause?: LaunchCause
  ): Promise<SessionManageResumeReply>
  rename(
    target: { paneKey?: string; tabId?: string },
    title: string,
    change?: OrganizationRelayedChange
  ): Promise<SessionManageRenameReply>
  sleep(ms: number): Promise<void>
  now(): number
}

export type SessionControlTarget = {
  entry: SessionManageEntry
  row: SessionManageSidebarRow
  source: ConversationSource | null
  agentProcess: TerminalAgentProcessProof | null
}

type Input = { actor: SessionManageActor; target: SessionControlTarget; dryRun: boolean }

function base(input: Input, action: SessionManageActionResult['action']) {
  return {
    dryRun: input.dryRun,
    action,
    target: { paneKey: input.target.entry.paneKey, title: input.target.entry.title },
    actor: input.actor
  }
}

function rowTarget(row: SessionManageSidebarRow): { paneKey?: string; tabId?: string } {
  return {
    ...(row.paneKey ? { paneKey: row.paneKey } : {}),
    ...(row.tabId ? { tabId: row.tabId } : {})
  }
}

/** Stop and restart refuse the caller itself, a chat view, and anything not verified. */
function assertControllable(input: Input, verb: 'stop' | 'restart'): void {
  assertUnattendedPolicy(input.actor, verb)
  const { entry } = input.target
  const name = `“${entry.title}”`
  if (isSelfTarget(input.actor, entry.paneKey)) {
    throw new SessionManageRefusal(
      `That is the session running this command; it cannot ${verb} itself. Nothing changed.`
    )
  }
  if (entry.kind === 'chat') {
    throw new SessionManageRefusal(
      `${name} is a chat-view conversation; ${verb} it from its own tab. session ${verb} handles terminal conversations. Nothing changed.`
    )
  }
  const remote = remoteExecutionRefusal(entry, verb)
  const ownerGuardedStop =
    verb === 'stop' &&
    parseExecutionHostId(entry.hostId)?.kind === 'ssh' &&
    Boolean(input.target.agentProcess?.interruptToken)
  if (remote && !ownerGuardedStop) {
    throw new SessionManageRefusal(remote)
  }
  if (entry.verdict === 'unverifiable' || (entry.verdict === 'live' && entry.state === 'unknown')) {
    throw new SessionManageRefusal(
      `${name} cannot be verified (${entry.waitingOn ?? 'its state is unknown'}), so nothing changed. Unknown is never treated as stopped or dead.`
    )
  }
}

function assertInterruptible(input: Input, force = false): TerminalAgentProcessProof {
  const { entry, agentProcess } = input.target
  if (!agentProcess || entry.agentForeground !== true || (!force && entry.stateBasis === 'title')) {
    throw new SessionManageRefusal(
      'The target agent and its active turn cannot be verified, so nothing was interrupted.'
    )
  }
  return agentProcess
}

export async function stopSession(
  deps: SessionControlDeps,
  input: Input & { force: boolean }
): Promise<SessionManageActionResult> {
  assertControllable(input, 'stop')
  const { entry, source } = input.target
  const name = `“${entry.title}”`
  if (entry.verdict === 'exited' || !source) {
    throw new SessionManageRefusal(`${name} has already exited; there is nothing to stop.`)
  }
  if (!input.force && (entry.state === 'awaiting-user' || entry.state === 'waiting-for-yes')) {
    throw new SessionManageRefusal(
      `${name} holds an unanswered decision (${entry.waitingOn ?? entry.state}), so nothing was stopped. Pass --force to stop it anyway.`
    )
  }
  const interrupt = (entry.state === 'working' || entry.state === 'awaiting-user') && entry.terminal
  const receiver = interrupt ? assertInterruptible(input, input.force) : null
  const queued = entry.queueLength
    ? ` Its ${entry.queueLength} queued prompt${entry.queueLength === 1 ? '' : 's'} will still be sent when it is free; remove them from its queue strip to hold them.`
    : ''
  if (input.dryRun) {
    const what = interrupt
      ? `Would interrupt ${name}'s agent`
      : `${name} is not working, so nothing would be interrupted`
    return {
      ...base(input, 'stop'),
      keepGoingStopped: entry.keepGoing,
      summary: `${what}${entry.keepGoing ? '; its Keep going would be turned off' : ''} (dry run: nothing changed).${queued}`
    }
  }
  const stopped = deps.stopKeepGoing(
    source,
    `${sessionManageActorTitle(input.actor)} stopped this conversation at your request.`
  )
  if (interrupt) {
    await afterApplied(stopped ? 'its Keep going was turned off' : null, () =>
      deps.interrupt(entry.terminal!, receiver!, source)
    )
  }
  return {
    ...base(input, 'stop'),
    keepGoingStopped: stopped,
    summary: `${interrupt ? `Interrupted ${name}'s agent` : `${name} was not working, so nothing was interrupted`}${stopped ? '; its Keep going is off now' : ''}.${queued}`
  }
}

async function unstickHung(
  deps: SessionControlDeps,
  input: Input
): Promise<SessionManageActionResult> {
  const { entry, source } = input.target
  const name = `“${entry.title}”`
  const handle = entry.terminal
  if (entry.state !== 'working' || !handle || !source) {
    throw new SessionManageRefusal(
      `${name} is ${entry.state} and live, so there is nothing to restart. Restart resumes an exited session or unsticks a hung one.`
    )
  }
  const receiver = assertInterruptible(input)
  const lastOutputAt = await deps.lastOutputAt(handle)
  const quietMs = lastOutputAt === null ? null : deps.now() - lastOutputAt
  if (quietMs === null || quietMs < SESSION_HUNG_AFTER_MS) {
    throw new SessionManageRefusal(
      `${name} is working and its terminal printed within the last ${SESSION_HUNG_AFTER_MS / 60_000} minutes, so it is not hung. Nothing changed; stop it with omni session stop if it must stop.`
    )
  }
  const minutes = Math.round(quietMs / 60_000)
  if (input.dryRun) {
    return {
      ...base(input, 'restart'),
      keepGoingStopped: entry.keepGoing,
      summary: `Would interrupt ${name}'s hung turn (no output for ${minutes} min)${entry.keepGoing ? ' and turn its Keep going off' : ''}; the same conversation stays and nothing is re-sent (dry run: nothing changed).`
    }
  }
  const stopped = deps.stopKeepGoing(
    source,
    `${sessionManageActorTitle(input.actor)} restarted this hung conversation at your request.`
  )
  await afterApplied(stopped ? 'its Keep going was turned off' : null, () =>
    deps.interrupt(handle, receiver, source)
  )
  for (let waited = 0; waited < HUNG_RECOVERY_WAIT_MS; waited += HUNG_RECOVERY_POLL_MS) {
    await deps.sleep(HUNG_RECOVERY_POLL_MS)
    if (!(await deps.stillWorking(handle, receiver))) {
      return {
        ...base(input, 'restart'),
        keepGoingStopped: stopped,
        summary: `Interrupted ${name}'s hung turn (no output for ${minutes} min); it is back at its prompt in the same conversation. Nothing was re-sent.`
      }
    }
  }
  return {
    ...base(input, 'restart'),
    keepGoingStopped: stopped,
    summary: `Interrupted ${name}'s hung turn (no output for ${minutes} min), but it has not returned to its prompt after ${HUNG_RECOVERY_WAIT_MS / 1000}s. Close its terminal (omni terminal close --terminal ${handle}), then run omni session restart again to resume the same conversation.`
  }
}

export async function restartSession(
  deps: SessionControlDeps,
  input: Input
): Promise<SessionManageActionResult> {
  assertControllable(input, 'restart')
  const { entry, row } = input.target
  const name = `“${entry.title}”`
  if (entry.verdict === 'live') {
    return unstickHung(deps, input)
  }
  if (!row.resumable) {
    throw new SessionManageRefusal(
      `${name} exited without a resumable checkpoint, so it cannot continue the same conversation. Start it again from its tab. Nothing changed.`
    )
  }
  const away = relocatedAwayRefusal({ agent: row.agent, sessionId: row.providerSessionId })
  if (away) {
    throw new SessionManageRefusal(away)
  }
  if (input.dryRun) {
    return {
      ...base(input, 'restart'),
      summary: `Would resume ${name}: the same ${entry.agent} conversation, in a new tab; nothing is re-sent (dry run: nothing changed).`
    }
  }
  const reply = await deps.resume(rowTarget(row), {
    trigger: input.actor.kind === 'steward' ? 'steward-resume' : 'session-resume',
    parentPaneKey: row.paneKey ?? undefined,
    actor:
      input.actor.kind === 'remote'
        ? { kind: 'paired-device' }
        : {
            kind: input.actor.kind === 'steward' ? 'app' : 'local-cli',
            ...(input.actor.kind === 'pane' ? { paneKey: input.actor.paneKey } : {})
          }
  })
  return { ...base(input, 'restart'), summary: reply.summary }
}

export async function renameSession(
  deps: SessionControlDeps,
  input: Input & { title: string; change?: OrganizationRelayedChange }
): Promise<
  SessionManageActionResult & {
    before?: string
    after?: string
    organization?: OrganizationRelayedOutcome
  }
> {
  assertUnattendedPolicy(input.actor, 'rename')
  const { entry, row } = input.target
  if (!row.tabId) {
    throw new SessionManageRefusal(
      `“${entry.title}” has no open tab, so there is no name to change. Nothing changed.`
    )
  }
  const title = input.title.trim()
  if (input.dryRun) {
    return {
      ...base(input, 'rename'),
      summary: `Would rename “${entry.title}” to “${title}” in the sidebar and its tab (dry run: nothing changed).`
    }
  }
  const reply = input.change
    ? await deps.rename(rowTarget(row), title, input.change)
    : await deps.rename(rowTarget(row), title)
  return {
    ...base(input, 'rename'),
    summary: reply.summary,
    before: reply.before,
    after: reply.after,
    ...(reply.organization ? { organization: reply.organization } : {})
  }
}
