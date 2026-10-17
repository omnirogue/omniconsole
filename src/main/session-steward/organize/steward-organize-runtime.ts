/**
 * The steward's organizing on this host (Phase 3): the real sources behind a pass and the `project`
 * suggestion's action. The steward's rules pass (`startSessionSteward`) drives it.
 */

import { join } from 'node:path'
import type { SessionBatchOriginsSnapshot } from '../../../shared/session-batch-origin'
import type { SessionFolderListResult } from '../../../shared/session-folder-cli'
import type { OrcaRuntimeService } from '../../runtime/omni-runtime'
import { auditActor } from '../../session-manage/session-actions-log'
import {
  observeSessionOwnerRows,
  runtimeSessionOwnerDeps
} from '../../session-manage/session-manage-owner-runtime'
import { readSidebarRows } from '../../session-manage/session-manage-runtime-actions'
import { sessionOrganizationLedgerFor } from '../../session-organization/organization-change-ledger'
import { organizeSessions } from '../../session-organization/organization-organize'
import {
  executorForActor,
  relayOrganizationMutation
} from '../../session-organization/organization-relayed-mutation'
import { jevDecide } from '../../structured-decisions/jev-rank'
import { stewardOrganizeMode, stewardSettings } from '../steward-switches'
import { stewardAccuracyGuardFor } from './steward-accuracy-guard'
import { StewardOrganizeState } from './steward-organize-state'
import {
  runStewardOrganizePass,
  type StewardOrganizePassDeps,
  type StewardOrganizePassOutcome
} from './steward-organize-pass'
import { stewardMergeAcceptor } from './steward-merge-suggest'
import {
  runtimeStewardConsolidate,
  runtimeStewardRetitleMergeDeps
} from './steward-retitle-merge-runtime'
import { stewardProjectAcceptor } from './steward-project-suggest'
import type { StewardOrganizeDeps } from './steward-refile'
import { registerStewardSuggestionAcceptor } from './steward-suggestion-accept'
import { STEWARD_DIRECTORY, stewardSuggestionsFor } from './steward-suggestions-store'

/** Organizing runs from the rules pass, but at most this often. */
export const STEWARD_ORGANIZE_PASS_MS = 10 * 60_000

function snapshotOf(value: unknown): SessionBatchOriginsSnapshot | null {
  const raw = value as Partial<SessionBatchOriginsSnapshot> | null | undefined
  // Why null: an older window answers a kind it does not know with nothing.
  return raw && typeof raw.folders === 'object' && typeof raw.sessions === 'object'
    ? { folders: raw.folders ?? {}, sessions: raw.sessions ?? {} }
    : null
}

export function runtimeStewardOrganizeDeps(
  runtime: OrcaRuntimeService,
  userDataPath: string,
  state: StewardOrganizeState,
  now: () => number = Date.now
): StewardOrganizeDeps {
  const ledger = () => sessionOrganizationLedgerFor(userDataPath)
  const relay = (request: Parameters<OrcaRuntimeService['requestSessionFolders']>[0]) =>
    runtime.requestSessionFolders(request)
  const listFolders = async () =>
    ((await relay({ kind: 'list' })) as SessionFolderListResult).folders
  const owner = runtimeSessionOwnerDeps(runtime, [])
  return {
    now,
    rows: async () => observeSessionOwnerRows(runtime, await readSidebarRows(runtime)),
    folders: listFolders,
    batchOrigins: async () => snapshotOf(await relay({ kind: 'listBatchOrigins' })),
    history: (key) => ledger().history(key),
    goal: (observed) => owner.goal(observed.row),
    decide: (request) => jevDecide(request, { caller: 'session-steward.organize' }),
    apply: async (plan, actor) => {
      const executor = executorForActor(actor)
      const audit = auditActor(actor)
      const rows = await readSidebarRows(runtime)
      return organizeSessions(
        { plan, apply: true, executor, actor, audit },
        {
          readRows: async () =>
            (await observeSessionOwnerRows(runtime, rows)).map(({ row, entry }) => ({
              row,
              state: entry.state
            })),
          listFolders,
          mutateFolder: (op) =>
            relayOrganizationMutation(ledger(), relay, {
              op,
              executor,
              actor: audit,
              ...(plan.reason ? { reason: plan.reason } : {}),
              ...(plan.request ? { request: plan.request } : {})
            }),
          ledger: ledger(),
          relay
        }
      )
    },
    state,
    guard: stewardAccuracyGuardFor(userDataPath),
    suggestions: stewardSuggestionsFor(userDataPath),
    mode: stewardOrganizeMode,
    pairReadsPerDay: () => stewardSettings().organize.pairReadsPerDay
  }
}

export type StewardOrganizeHandle = {
  /** One pass now; null when one is already running or it failed (logged once). */
  pass: () => Promise<StewardOrganizePassOutcome | null>
  /** What the rules pass calls each time: a pass when the last began 10 minutes ago or more. */
  passIfDue: () => Promise<StewardOrganizePassOutcome | null>
  stop: () => Promise<void>
}

/** What the rules loop calls each pass; registers the `project` and `merge` suggestions' actions. */
export function createStewardOrganize(options: {
  runtime: OrcaRuntimeService
  userDataPath: string
}): StewardOrganizeHandle {
  const state = new StewardOrganizeState({
    directory: join(options.userDataPath, STEWARD_DIRECTORY)
  })
  const deps: StewardOrganizePassDeps = {
    ...runtimeStewardOrganizeDeps(options.runtime, options.userDataPath, state),
    ...runtimeStewardRetitleMergeDeps(options.runtime, options.userDataPath)
  }
  const unregisterProject = registerStewardSuggestionAcceptor(
    'project',
    stewardProjectAcceptor(deps)
  )
  const unregisterMerge = registerStewardSuggestionAcceptor(
    'merge',
    stewardMergeAcceptor({
      rows: deps.rows,
      goal: deps.goal,
      consolidate: runtimeStewardConsolidate(options.runtime)
    })
  )
  let running: Promise<StewardOrganizePassOutcome | null> | null = null
  let lastFailure: string | null = null
  const pass = (): Promise<StewardOrganizePassOutcome | null> => {
    if (running) {
      return Promise.resolve(null)
    }
    running = runStewardOrganizePass(deps)
      .then((outcome) => {
        lastFailure = null
        return outcome
      })
      .catch((error: unknown) => {
        // Why once: no window (a headless relaunch) fails every pass the same way.
        const failure = error instanceof Error ? error.message : String(error)
        if (failure !== lastFailure) {
          lastFailure = failure
          console.warn('[session-steward] organizing pass failed', error)
        }
        return null
      })
      .finally(() => {
        running = null
      })
    return running
  }
  let lastStarted = Number.NEGATIVE_INFINITY
  return {
    pass,
    passIfDue: () => {
      const now = Date.now()
      if (now - lastStarted < STEWARD_ORGANIZE_PASS_MS) {
        return Promise.resolve(null)
      }
      lastStarted = now
      return pass()
    },
    stop: async () => {
      unregisterProject()
      unregisterMerge()
      await running
      await state.flush()
    }
  }
}
