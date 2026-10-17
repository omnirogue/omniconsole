/**
 * Moving a conversation away from this SSH relay (package B3): package C's relocation steps over
 * the relay's own panes, process table and disk (staging and export under its session host root).
 * The relay is a source only. A Mac opens every terminal a relay runs, so a conversation the relay
 * resumed itself would run where no one sees it; a move to it is refused before the source freezes.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SessionHostRelocationProvider } from '../shared/session-host-capabilities'
import { sessionHostRefusal } from '../shared/session-host-refusal'
import type { SessionHostAdmissionStore } from '../main/session-host/session-host-admission-store'
import type { SessionHostRegistration } from '../main/session-host/session-host-journal'
import type {
  RelocationDestinationHost,
  RelocationExitEvidence,
  RelocationSourceHost
} from '../main/session-manage/session-transfer-host-action-deps'
import {
  sessionTransferHostActions,
  type SessionTransferHostActions
} from '../main/session-manage/session-transfer-host-actions'
import {
  awaitRelocationExit,
  processGroupGone,
  signalAgentProcessGroup
} from '../main/session-manage/session-transfer-process-group'
import { sessionRelocationEnabled } from '../main/session-manage/session-transfer-relocation-switch'
import { locateTranscripts } from '../main/session-manage/session-transcript-locate'
import { RELOCATION_PROVIDER_ADAPTERS } from '../main/session-relocation/relocation-bundle-import'
import type { RelayPtyAgentEvidence } from './pty-agent-process-evidence'
import { relayOwnerSession, type RelayOwnerFacts } from './relay-owner-sessions'
import type { RelayTurnLedger } from './relay-owner-turns'

export type RelayRelocationDeps = {
  facts: RelayOwnerFacts
  turns: RelayTurnLedger
  /** The agent proven to hold this PTY, and what is left under it; null when unreadable. */
  agentEvidence(ptyId: string): Promise<RelayPtyAgentEvidence | null>
  /** Where transcripts are looked for: the relay user's home and its own data folder. */
  homeDir?: string
  userDataPath?: string
}

const PROVIDERS = Object.keys(RELOCATION_PROVIDER_ADAPTERS) as SessionHostRelocationProvider[]

export const RELAY_DESTINATION_REFUSAL = sessionHostRefusal(
  'not-eligible',
  'An SSH host cannot take a moved conversation yet: a Mac opens its terminals, so one it resumed on its own would run where no one sees it. Move it to a Mac, or hand the work to a new session there (omni session handoff). Nothing was changed.'
)

type HeldPane = { ptyId: string; state: string }

/** The live pane this registration binds, still holding its conversation; else why not. */
function heldPane(
  deps: RelayRelocationDeps,
  registration: SessionHostRegistration
): HeldPane | string {
  const paneKey = registration.binding?.paneKey
  if (!paneKey) {
    return 'that conversation has no pane on this SSH host'
  }
  const session = relayOwnerSession(deps.facts, deps.turns, paneKey)
  if (!session.pane?.alive) {
    return 'its terminal on this SSH host is gone, so its agent cannot be proven stopped'
  }
  if (session.providerSessionId && session.providerSessionId !== registration.provider.sessionId) {
    return 'its pane on this SSH host now holds another conversation'
  }
  return { ptyId: session.pane.ptyId, state: session.state }
}

export function relayRelocationSourceHost(deps: RelayRelocationDeps): RelocationSourceHost {
  // The group each freeze ended, so later steps re-prove the same group is still gone.
  const ended = new Map<string, number>()
  const evidence = async (
    registration: SessionHostRegistration
  ): Promise<RelocationExitEvidence> => {
    const held = heldPane(deps, registration)
    if (typeof held === 'string') {
      return { stopped: false, reason: held }
    }
    const read = await deps.agentEvidence(held.ptyId)
    const group = ended.get(registration.conversationId)
    if (!read) {
      return { stopped: false, reason: 'its process table could not be read' }
    }
    if (read.proof || read.tree.kind !== 'agent-gone') {
      return {
        stopped: false,
        reason:
          read.tree.kind === 'stopped'
            ? 'a process under its terminal is suspended'
            : 'its agent is still running under its terminal'
      }
    }
    if (group !== undefined && !processGroupGone(group)) {
      return { stopped: false, reason: 'a process of its agent is still running' }
    }
    return {
      stopped: true,
      evidence:
        'No agent process is left under its terminal on this SSH host, only a shell holds it, and its process group is gone.'
    }
  }
  return {
    freeze: async ({ registration }) => {
      if (process.platform === 'win32') {
        return {
          stopped: false,
          reason: 'Stopping with proof of exit is not available on Windows yet.'
        }
      }
      const held = heldPane(deps, registration)
      if (typeof held === 'string') {
        return { stopped: false, reason: held }
      }
      const read = await deps.agentEvidence(held.ptyId)
      if (read && !read.proof && read.tree.kind === 'agent-gone') {
        return await evidence(registration)
      }
      if (!read?.proof) {
        return {
          stopped: false,
          reason: 'its agent process holding the terminal cannot be verified'
        }
      }
      if (held.state !== 'idle') {
        return {
          stopped: false,
          reason: `it is ${held.state}; only an idle conversation is frozen`
        }
      }
      const unsignalled = signalAgentProcessGroup(read.proof, (pgid) =>
        ended.set(registration.conversationId, pgid)
      )
      if (unsignalled) {
        return { stopped: false, reason: unsignalled }
      }
      return await awaitRelocationExit(() => evidence(registration))
    },
    exitEvidence: evidence,
    transcriptPath: async (registration) => {
      const { agent, sessionId } = registration.provider
      if (agent !== 'claude' && agent !== 'codex') {
        return null
      }
      const home = deps.homeDir ?? homedir()
      const located = await locateTranscripts(agent, sessionId, {
        userDataPath: deps.userDataPath ?? join(home, '.omni-relay'),
        homeDir: home
      }).catch(() => [])
      return located.length === 1 ? located[0]!.path : null
    },
    // Why nothing more: the relinquish tombstone refuses every action here and adoption never
    // registers it again; a relay has no organization to archive in, and the pane keeps its history.
    retire: async () => {}
  }
}

export function relayRelocationDestinationHost(): RelocationDestinationHost {
  return {
    check: async () => ({ ok: false, refusal: RELAY_DESTINATION_REFUSAL }),
    launch: async () => {
      throw new Error(RELAY_DESTINATION_REFUSAL.message)
    },
    confirm: async () => ({ state: 'unconfirmed' })
  }
}

/** C's relocation handler on this relay, reading its session host's store when a step runs. */
export function relayTransferHostActions(
  deps: RelayRelocationDeps & { store(): SessionHostAdmissionStore | null }
): SessionTransferHostActions {
  return sessionTransferHostActions({
    get store() {
      const store = deps.store()
      if (!store) {
        throw new Error('This SSH host’s session host is not open, so no move step can run.')
      }
      return store
    },
    relocationEnabled: sessionRelocationEnabled,
    relocationProviders: () => PROVIDERS,
    relocationSource: relayRelocationSourceHost(deps),
    relocationDestination: relayRelocationDestinationHost()
  })
}
