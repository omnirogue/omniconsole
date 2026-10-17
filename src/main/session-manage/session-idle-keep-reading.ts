/**
 * G1 for agent hibernation and the idle rules, read the way `omni session list` reads a session:
 * the Stage A1 state (`session-manage-pty-activity.ts`), its Keep going, whether a reply this
 * host holds for it asks something (ends with "?" or lists numbered questions), and whether the
 * row's own agent provably holds its terminal (the pid proof behind `agentForeground`). Any
 * reading that fails comes back `failed`, and the window keeps that pane.
 */

import type { ConversationSource } from '../../shared/conversation-source'
import { hasOpenAskText, type IdleKeepReading } from '../../shared/idle-auto-close-settings'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import { findSessionManageRow } from './session-manage-inventory'
import { observeSession } from './session-manage-observe'
import { readSidebarRows } from './session-manage-runtime-actions'
import {
  createRuntimeObserveSources,
  runtimeNeverReplied,
  snapshotRuntimeLatestTurn
} from './session-manage-runtime-sources'
import { projectSessionState } from './session-manage-state'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { pendingEventWaitOf } from '../session-steward/steward-waiters'

export type IdleKeepTarget = { worktreeId: string; paneKey: string }

export type IdleKeepReadingDeps = {
  rows(): Promise<readonly SessionManageSidebarRow[]>
  /** The Stage A1 state of one row, its Keep going, and whether its agent holds the terminal. */
  observe(
    row: SessionManageSidebarRow
  ): Promise<{ state: string; keepGoing: boolean; agentForeground: boolean | null }>
  /** Every reply this host holds for the conversation (latest turn, newest hook row). */
  replies(source: ConversationSource): readonly (string | null | undefined)[]
  /** An unanswered event wait in the pane's own plan, as its label; null when none. */
  waitingOn?(paneKey: string): string | null
}

function failed(paneKey: string): IdleKeepReading {
  return {
    paneKey,
    listed: false,
    state: null,
    openAsk: false,
    keepGoing: false,
    agentForeground: null,
    failed: true
  }
}

export async function readIdleKeepReadings(
  deps: IdleKeepReadingDeps,
  targets: readonly IdleKeepTarget[]
): Promise<IdleKeepReading[]> {
  let rows: readonly SessionManageSidebarRow[]
  try {
    rows = await deps.rows()
  } catch {
    return targets.map((target) => failed(target.paneKey))
  }
  const readings: IdleKeepReading[] = []
  // Why sequential: each observation may read a terminal's screen and processes.
  for (const target of targets) {
    try {
      const row = findSessionManageRow(rows, { paneKey: target.paneKey })
      if (!row || row.worktreeId !== target.worktreeId) {
        readings.push({
          paneKey: target.paneKey,
          listed: false,
          state: null,
          openAsk: false,
          keepGoing: false,
          agentForeground: null
        })
        continue
      }
      const source: ConversationSource = {
        worktreeId: row.worktreeId,
        paneKey: target.paneKey,
        kind: 'pty'
      }
      const observed = await deps.observe(row)
      const waitingOn = deps.waitingOn?.(target.paneKey) ?? null
      readings.push({
        ...(waitingOn ? { waitingOn } : {}),
        paneKey: target.paneKey,
        listed: true,
        state: observed.state,
        keepGoing: observed.keepGoing,
        agentForeground: observed.agentForeground,
        openAsk: deps.replies(source).some((reply) => hasOpenAskText(reply))
      })
    } catch {
      readings.push(failed(target.paneKey))
    }
  }
  return readings
}

export function runtimeIdleKeepReadingDeps(runtime: OrcaRuntimeService): IdleKeepReadingDeps {
  const sources = createRuntimeObserveSources(runtime)
  return {
    rows: () => readSidebarRows(runtime),
    observe: async (row) => {
      const observed = await observeSession(row, sources)
      return {
        state: projectSessionState(observed.facts).state,
        keepGoing: observed.keepGoing,
        agentForeground: observed.agentForeground
      }
    },
    replies: (source) => [
      snapshotRuntimeLatestTurn(source, runtimeNeverReplied(runtime)).text,
      runtime.getLastAgentHookRowForPane(source.paneKey)?.lastAssistantMessage
    ],
    waitingOn: (paneKey) => pendingEventWaitOf(runtime.listSessionChains(), paneKey)
  }
}
