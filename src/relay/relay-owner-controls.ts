/**
 * Controls an SSH relay carries out itself for the sessions it runs (package B2). A prompt goes to
 * the agent's terminal only while its own hook says it finished its turn and the agent holds the
 * terminal's foreground, re-proven just before the text and again before Enter, behind the
 * caller's marker and the same hard-stop and approval checks a Mac applies. An automatic caller
 * never prompts here (the relay keeps no prompt limits), and nothing here archives.
 */

import {
  AGENT_PROMPT_SUBMIT,
  buildAgentPromptPasteBytes,
  getTerminalPasteIngestMs
} from '../shared/agent-prompt-injection'
import type { SessionHostPayloads } from '../shared/session-host-payload-schema'
import { sessionHostRefusal, type SessionHostRefusal } from '../shared/session-host-refusal'
import {
  sessionManageActorTitle,
  sessionManageQuestionId,
  sessionManageQuestionMarker,
  type SessionManageActor
} from '../shared/session-manage-types'
import type { SessionHostPrepared } from '../main/session-host/session-host-executor'
import type { SessionHostSettlement } from '../main/session-host/session-host-settlement'
import {
  FREEFORM_NOT_AN_APPROVAL,
  freeformApprovalRefusal
} from '../main/session-manage/session-manage-freeform'
import { refuseHardStop, SessionManageRefusal } from '../main/session-manage/session-manage-refusal'
import { unattendedContextFor } from '../main/session-manage/session-manage-unattended'
import {
  RELAY_SILENT_AFTER_MS,
  relayAgentHoldsTerminal,
  relayOwnerSession,
  type RelayOwnerFacts,
  type RelayOwnerSession
} from './relay-owner-sessions'
import type { RelayTurnLedger } from './relay-owner-turns'

const INTERRUPT = '\x03'
const ASK_DEFAULT_TIMEOUT_MS = 10 * 60_000

export type RelayControlDeps = {
  facts: RelayOwnerFacts
  turns: RelayTurnLedger
  sleep(ms: number): Promise<void>
  newId(): string
}

const refuse = (code: SessionHostRefusal['code'], message: string): SessionHostPrepared => ({
  kind: 'refuse',
  refusal: sessionHostRefusal(code, message)
})

/** The hard stops, and (for a free prompt) that it does not read as an approval. */
function checkedText(text: string, freeform = true): SessionHostRefusal | null {
  try {
    refuseHardStop(text)
  } catch (error) {
    if (error instanceof SessionManageRefusal) {
      return sessionHostRefusal('hard-stop', error.message)
    }
    throw error
  }
  const approval = freeform ? freeformApprovalRefusal(text) : null
  return approval ? sessionHostRefusal('not-eligible', approval) : null
}

/** Free now: live, finished its turn by its own report, and its agent holds the terminal. */
async function idleRefusal(
  deps: RelayControlDeps,
  session: RelayOwnerSession
): Promise<SessionHostRefusal | null> {
  if (session.verdict !== 'live') {
    return sessionHostRefusal(
      'not-eligible',
      session.verdict === 'exited'
        ? 'It has exited on that SSH host. Nothing was sent.'
        : 'That SSH host holds no terminal for it now, so it cannot be verified. Nothing was sent.'
    )
  }
  if (session.state !== 'idle') {
    return sessionHostRefusal(
      'not-eligible',
      session.state === 'awaiting-user'
        ? 'It is waiting on the person; a prompt cannot answer that. Nothing was sent.'
        : 'It has not finished its turn by its own report, so nothing was sent. Observe it again once it is free.'
    )
  }
  return (await relayAgentHoldsTerminal(deps.facts, session))
    ? null
    : sessionHostRefusal(
        'not-eligible',
        'Its agent could not be proven to hold its terminal, so nothing was sent: a prompt must never reach a shell.'
      )
}

/** Paste, let the terminal take it in, prove the agent still holds it, then Enter. */
async function writePrompt(
  deps: RelayControlDeps,
  paneKey: string,
  text: string
): Promise<SessionHostSettlement> {
  const before = relayOwnerSession(deps.facts, deps.turns, paneKey)
  const refused = await idleRefusal(deps, before)
  if (refused || !before.pane) {
    return {
      kind: 'not-delivered',
      refusal:
        refused ?? sessionHostRefusal('not-eligible', 'Its terminal is gone. Nothing was sent.')
    }
  }
  const paste = buildAgentPromptPasteBytes(text)
  if (!deps.facts.write(before.pane.ptyId, paste)) {
    return {
      kind: 'not-delivered',
      refusal: sessionHostRefusal('not-eligible', 'Its terminal is gone. Nothing was sent.')
    }
  }
  await deps.sleep(getTerminalPasteIngestMs(process.platform, Buffer.byteLength(paste, 'utf8')))
  const after = relayOwnerSession(deps.facts, deps.turns, paneKey)
  if (
    after.pane?.ptyId !== before.pane.ptyId ||
    !(await relayAgentHoldsTerminal(deps.facts, after))
  ) {
    return {
      kind: 'unconfirmed',
      detail: 'The text was pasted, but the agent no longer held the terminal for Enter.'
    }
  }
  if (!deps.facts.write(before.pane.ptyId, AGENT_PROMPT_SUBMIT)) {
    return { kind: 'unconfirmed', detail: 'The text was pasted, but Enter could not be written.' }
  }
  return { kind: 'completed', result: { deliveredAt: deps.facts.now(), door: 'pty' } }
}

function automaticPrompt(actor: SessionManageActor): SessionHostPrepared | null {
  return unattendedContextFor(actor)
    ? refuse(
        'unattended-restricted',
        'An automatic caller never prompts a session on an SSH host: it keeps no prompt limits there. Nothing was sent.'
      )
    : null
}

export async function prepareRelayContinue(
  deps: RelayControlDeps,
  session: RelayOwnerSession,
  actor: SessionManageActor,
  marker: string,
  payload: SessionHostPayloads['continue']
): Promise<SessionHostPrepared> {
  const automatic = automaticPrompt(actor)
  if (automatic) {
    return automatic
  }
  if (payload.answer.kind !== 'prompt') {
    return refuse(
      'not-eligible',
      'An SSH host reads no proposals of its own, so it cannot say yes to one. Send the words as a prompt. Nothing was sent.'
    )
  }
  const text = `${marker}${FREEFORM_NOT_AN_APPROVAL}\n${payload.answer.text}`
  const problem = checkedText(payload.answer.text) ?? (await idleRefusal(deps, session))
  if (problem) {
    return { kind: 'refuse', refusal: problem }
  }
  return { kind: 'dispatch', dispatch: () => writePrompt(deps, session.paneKey, text) }
}

/**
 * A connected Mac's own automatic writer (its queue, Keep going, a chain, Up next): its exact text,
 * admitted on this turn like any other writer, under the same idle and foreground proof. The Mac
 * applied its own limits; an automatic writer's text still passes the hard stops here.
 */
export async function prepareRelayDeliver(
  deps: RelayControlDeps,
  session: RelayOwnerSession,
  actor: SessionManageActor,
  payload: SessionHostPayloads['deliver']
): Promise<SessionHostPrepared> {
  const hardStop = unattendedContextFor(actor) ? checkedText(payload.text, false) : null
  const problem = hardStop ?? (await idleRefusal(deps, session))
  if (problem) {
    return { kind: 'refuse', refusal: problem }
  }
  return { kind: 'dispatch', dispatch: () => writePrompt(deps, session.paneKey, payload.text) }
}

export async function prepareRelayAsk(
  deps: RelayControlDeps,
  session: RelayOwnerSession,
  actor: SessionManageActor,
  payload: SessionHostPayloads['ask']
): Promise<SessionHostPrepared> {
  const automatic = automaticPrompt(actor)
  if (automatic) {
    return automatic
  }
  const marker = sessionManageQuestionMarker(
    sessionManageActorTitle(actor),
    sessionManageQuestionId(deps.newId())
  )
  const problem = checkedText(payload.question) ?? (await idleRefusal(deps, session))
  if (problem) {
    return { kind: 'refuse', refusal: problem }
  }
  const text = `${marker}${FREEFORM_NOT_AN_APPROVAL}\n${payload.question}`
  return {
    kind: 'dispatch',
    dispatch: async () => {
      // Why listen first: the answer must not finish before anything is waiting for it.
      const answered = deps.turns.nextTurn(
        session.paneKey,
        payload.timeoutMs ?? ASK_DEFAULT_TIMEOUT_MS
      )
      const sent = await writePrompt(deps, session.paneKey, text)
      if (sent.kind !== 'completed') {
        return sent
      }
      const turn = await answered
      return {
        kind: 'completed',
        result: turn?.reply ? { outcome: 'answered', reply: turn.reply } : { outcome: 'timeout' }
      }
    }
  }
}

export async function prepareRelayStop(
  deps: RelayControlDeps,
  session: RelayOwnerSession,
  actor: SessionManageActor,
  payload: SessionHostPayloads['stop']
): Promise<SessionHostPrepared> {
  if (unattendedContextFor(actor)) {
    return refuse(
      'unattended-restricted',
      'A steward run cannot stop a session; that needs the person. Nothing changed.'
    )
  }
  if (session.verdict !== 'live') {
    return refuse('not-eligible', 'It is not running on that SSH host; there is nothing to stop.')
  }
  if (session.state === 'awaiting-user' && !payload.force) {
    return refuse(
      'not-eligible',
      'It holds an unanswered decision, so nothing was stopped. Stop it with force to stop it anyway.'
    )
  }
  // Why a forced decision too: as on a Mac, stop with force interrupts an agent waiting on the person.
  if (session.state !== 'working' && session.state !== 'awaiting-user') {
    return {
      kind: 'dispatch',
      dispatch: async () => ({
        kind: 'completed',
        result: { summary: 'It was not working, so nothing was interrupted.' }
      })
    }
  }
  return interrupt(deps, session)
}

async function interrupt(
  deps: RelayControlDeps,
  session: RelayOwnerSession
): Promise<SessionHostPrepared> {
  if (!session.pane || !(await relayAgentHoldsTerminal(deps.facts, session))) {
    return refuse(
      'not-eligible',
      'Its agent could not be proven to hold its terminal, so nothing was interrupted.'
    )
  }
  const ptyId = session.pane.ptyId
  return {
    kind: 'dispatch',
    dispatch: async () =>
      deps.facts.write(ptyId, INTERRUPT)
        ? { kind: 'completed', result: { summary: 'Interrupted its agent.' } }
        : {
            kind: 'not-delivered',
            refusal: sessionHostRefusal(
              'not-eligible',
              'Its terminal is gone. Nothing was interrupted.'
            )
          }
  }
}

export async function prepareRelayRestart(
  deps: RelayControlDeps,
  session: RelayOwnerSession,
  actor: SessionManageActor
): Promise<SessionHostPrepared> {
  if (unattendedContextFor(actor)) {
    return refuse(
      'unattended-restricted',
      'A steward run cannot restart a session; that needs the person. Nothing changed.'
    )
  }
  if (session.verdict !== 'live') {
    return refuse(
      'not-eligible',
      'An SSH host resumes an exited conversation only through a Mac that shows it (it opens the tab). Nothing changed.'
    )
  }
  const quietFor = session.statusAt === null ? null : deps.facts.now() - session.statusAt
  if (session.state !== 'working' || quietFor === null || quietFor < RELAY_SILENT_AFTER_MS) {
    return refuse(
      'not-eligible',
      'It is not hung (it reported within the last 10 minutes, or it is not working). Nothing changed.'
    )
  }
  return interrupt(deps, session)
}
