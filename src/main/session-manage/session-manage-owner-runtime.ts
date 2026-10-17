/** The real readings behind `session find-owner` and `session assign`, shared with session prep. */

import { AI_VAULT_AGENTS, type AiVaultAgent } from '../../shared/ai-vault-types'
import { sessionGoalFromPrompt } from '../../shared/session-goal'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import type { SessionManageActor } from '../../shared/session-manage-types'
import type { SessionFindOwnerResult } from '../../shared/session-owner-types'
import { SESSION_SEARCH_QUERY_MAX_CHARS } from '../../shared/session-search-types'
import { handleAiVaultGetFirstUserPrompt } from '../ai-vault/session-first-user-prompt-handler'
import { getProfileUserDataPath } from '../omni-profiles/profile-storage-paths'
import { isChainBoundToConversation } from '../runtime/conversation-chain-ownership'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { searchSessionsOnHosts } from '../session-search/session-search-hosts'
import { assignSession } from './session-manage-assign'
import type { SessionDeliveryTarget } from './session-manage-deliver'
import { observeSessionManageRows, toSessionManageEntry } from './session-manage-inventory'
import { observeSession } from './session-manage-observe'
import {
  findSessionOwnerWithPastWork,
  type SessionOwnerPastDeps
} from './session-manage-owner-past'
import { readConversationOrganization } from './session-manage-resume-runtime'
import {
  findSessionOwner,
  type SessionOwnerDeps,
  type SessionOwnerObserved,
  type SessionOwnerScope
} from './session-manage-owner'
import { withTranscriptFirstTurn } from './session-manage-first-turn'
import type { SessionLatestTurn } from './session-manage-freeform'
import { judgeSessionOwner } from './session-manage-owner-jev'
import { joinSessionSearchHitsToRows } from './session-manage-owner-search'
import { readSessionWorktreeChanges } from './session-manage-conflicts'
import { runtimeDeliveryDeps, runtimeReadChangedFiles } from './session-manage-runtime-actions'
import { createRuntimeObserveSources } from './session-manage-runtime-sources'
import {
  createSessionOwnerTimingRecorder,
  timedSessionOwnerDeps,
  timedSessionOwnerPastDeps,
  type SessionOwnerTimingRecorder
} from './session-manage-owner-timing'

const SEARCH_LIMIT = 20

function isAiVaultAgent(agent: string): agent is AiVaultAgent {
  return (AI_VAULT_AGENTS as readonly string[]).includes(agent)
}

/** A search query from the task: its opening words, cut at a word boundary. */
export function sessionOwnerSearchQuery(task: string): string {
  const flat = task.replace(/\s+/g, ' ').trim()
  if (flat.length <= SESSION_SEARCH_QUERY_MAX_CHARS) {
    return flat
  }
  const cut = flat.slice(0, SESSION_SEARCH_QUERY_MAX_CHARS)
  const space = cut.lastIndexOf(' ')
  return space > 0 ? cut.slice(0, space) : cut
}

export function runtimeChainBound(
  runtime: Pick<OrcaRuntimeService, 'listSessionChains'>,
  row: Pick<SessionManageSidebarRow, 'paneKey' | 'worktreeId'>
): boolean {
  return row.paneKey !== null
    ? isChainBoundToConversation(runtime, { paneKey: row.paneKey, worktreeId: row.worktreeId })
    : false
}

export async function observeSessionOwnerRows(
  runtime: OrcaRuntimeService,
  rows: readonly SessionManageSidebarRow[]
): Promise<SessionOwnerObserved[]> {
  const observed = await observeSessionManageRows(
    rows.filter((row) => !row.folded && !row.archived),
    createRuntimeObserveSources(runtime)
  )
  return observed.map(({ row, entry }) => ({
    row,
    entry,
    bound: runtimeChainBound(runtime, row)
  }))
}

export function runtimeSessionOwnerDeps(
  runtime: OrcaRuntimeService,
  rows: readonly SessionManageSidebarRow[]
): SessionOwnerDeps {
  const providerSession = (paneKey: string) =>
    runtime.getLastAgentHookRowForPane(paneKey)?.providerSession ?? null
  return {
    search: async (task) => {
      const result = await searchSessionsOnHosts(getProfileUserDataPath(), {
        query: sessionOwnerSearchQuery(task),
        limit: SEARCH_LIMIT,
        includeRemote: false
      })
      const local = result.hosts.find((host) => host.executionHostId === 'local')
      const matches = new Map<string, { summary: string | null }>()
      for (const hit of joinSessionSearchHitsToRows(
        result.hits,
        rows,
        (paneKey) => providerSession(paneKey)?.id ?? null
      )) {
        if (hit.paneKey && !matches.has(hit.paneKey)) {
          matches.set(hit.paneKey, { summary: hit.summary })
        }
      }
      const searched = local?.state === 'searched'
      return {
        matches,
        searched,
        hits: result.hits,
        ...(!searched ? { note: local?.message ?? local?.state ?? 'no local search' } : {})
      }
    },
    goal: async (row) => {
      const session = row.paneKey ? providerSession(row.paneKey) : null
      if (!session?.transcriptPath || !isAiVaultAgent(row.agent)) {
        return null
      }
      const { prompt } = await handleAiVaultGetFirstUserPrompt({
        agent: row.agent,
        filePath: session.transcriptPath,
        sessionId: session.id,
        executionHostId: 'local'
      })
      return sessionGoalFromPrompt(prompt)?.line ?? null
    },
    judge: (task, session) => judgeSessionOwner(task, session),
    changes: (live) => readSessionWorktreeChanges(live, runtimeReadChangedFiles(runtime))
  }
}

/** Past work's readings: archived and exited rows observed, closed ones' filing, goals, JEV. */
export function runtimeSessionOwnerPastDeps(runtime: OrcaRuntimeService): SessionOwnerPastDeps {
  return {
    observe: async (row) =>
      toSessionManageEntry(await observeSession(row, createRuntimeObserveSources(runtime))),
    organization: (reference) => readConversationOrganization(runtime, reference),
    goal: async (hit) => {
      const { prompt } = await handleAiVaultGetFirstUserPrompt({
        agent: hit.agent,
        filePath: hit.transcriptPath,
        sessionId: hit.sessionId,
        executionHostId: 'local'
      })
      return sessionGoalFromPrompt(prompt)?.line ?? null
    },
    judge: (task, session) => judgeSessionOwner(task, session)
  }
}

/**
 * Every sidebar conversation read now, then `findSessionOwner` over the live local ones; with
 * `pastWork`, also the archived, exited and closed conversations the same search found.
 */
export async function findSessionOwnerOnRuntime(
  runtime: OrcaRuntimeService,
  rows: readonly SessionManageSidebarRow[],
  input: {
    task: string
    files?: readonly string[]
    scope: SessionOwnerScope
    exclude?: ReadonlySet<string>
    conflictExclude?: ReadonlySet<string>
    pastWork?: boolean
  },
  timing: SessionOwnerTimingRecorder = createSessionOwnerTimingRecorder()
): Promise<SessionFindOwnerResult> {
  const { pastWork, ...query } = input
  const observed = await timing.time('live-inventory', () => observeSessionOwnerRows(runtime, rows))
  const deps = timedSessionOwnerDeps(runtimeSessionOwnerDeps(runtime, rows), timing)
  const result = await timing.time('matching', () =>
    pastWork
      ? findSessionOwnerWithPastWork(
          { ...query, observed, rows },
          { ...deps, past: timedSessionOwnerPastDeps(runtimeSessionOwnerPastDeps(runtime), timing) }
        )
      : findSessionOwner({ ...query, observed }, deps)
  )
  return { ...result, timing: timing.finish() }
}

/** `assignSession` with this runtime's queue, its chains read at the moment of sending. */
export function assignSessionOnRuntime(
  runtime: OrcaRuntimeService,
  input: {
    actor: SessionManageActor
    target: SessionDeliveryTarget & {
      row: Pick<SessionManageSidebarRow, 'paneKey' | 'worktreeId' | 'routine'>
    }
    task: string
    dryRun: boolean
    /** A just-resumed conversation's latest turn, read from its transcript (`-first-turn.ts`). */
    firstTurn?: () => Promise<SessionLatestTurn>
  }
) {
  const deps = runtimeDeliveryDeps(runtime)
  return assignSession(input.firstTurn ? withTranscriptFirstTurn(deps, input.firstTurn) : deps, {
    actor: input.actor,
    target: input.target,
    task: input.task,
    bound: runtimeChainBound(runtime, input.target.row),
    routine: input.target.row.routine === true,
    dryRun: input.dryRun
  })
}
