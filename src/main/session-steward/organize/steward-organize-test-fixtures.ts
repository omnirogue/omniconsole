/**
 * The organizing pass against a pretend window: the real history store, accuracy guard,
 * suggestions store and organize state; a window that applies each plan to in-memory rows and
 * folders and records it as the change path does; and JEV answers scripted per question.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionBatchOriginsSnapshot } from '../../../shared/session-batch-origin'
import type { SessionFolderEntry, SessionFolderOp } from '../../../shared/session-folder-cli'
import type { SessionManageActor } from '../../../shared/session-manage-types'
import type {
  OrganizationExecutor,
  OrganizationRecord
} from '../../../shared/session-organization-change'
import type { SessionOrganizePlan, SessionOrganizeResult } from '../../../shared/session-organize'
import {
  getDefaultStewardOrganizeSettings,
  type StewardGuardedFeature,
  type StewardOrganizeFeature,
  type StewardOrganizeMode
} from '../../../shared/session-steward-organize-settings'
import type { DecisionRequest, DecisionResult } from '../../../shared/structured-decisions'
import { OrganizationHistoryStore } from '../../session-organization/organization-history-store'
import { executorForActor } from '../../session-organization/organization-relayed-mutation'
import { manageEntry, sidebarRow } from '../../session-manage/session-manage-test-fixtures'
import { StewardAccuracyGuard } from './steward-accuracy-guard'
import { StewardOrganizeState } from './steward-organize-state'
import type { StewardOrganizePassDeps } from './steward-organize-pass'
import type { StewardTitleReading } from './steward-retitle'
import type { StewardOrganizeRow } from './steward-refile-candidates'
import { StewardSuggestionsStore } from './steward-suggestions-store'

export const HOUR = 60 * 60 * 1000
export const PERSON: OrganizationExecutor = { kind: 'person', via: 'sidebar' }

export function organizeRow(
  index: number,
  patch: Partial<StewardOrganizeRow['row']> = {},
  entry: Partial<StewardOrganizeRow['entry']> = {}
): StewardOrganizeRow {
  const paneKey = `tab-${index}:leaf-1`
  return {
    row: sidebarRow({
      rowKey: `row-${index}`,
      viewKey: `view-${index}`,
      paneKey,
      tabId: `tab-${index}`,
      title: `Session ${index}`,
      ...patch
    }),
    entry: manageEntry({ paneKey, tabId: `tab-${index}`, title: `Session ${index}`, ...entry }),
    bound: false
  }
}

export function folder(id: string, path: string, section: 'active' | 'saved' = 'active') {
  const names = path.split(' / ')
  return {
    id,
    name: names.at(-1)!,
    path,
    section,
    parentId: null,
    color: null,
    sessionCount: 0
  } satisfies SessionFolderEntry
}

/** Answers: folder fit by session title, "same project" by the two titles (any order). */
export type ScriptedJev = {
  folder: (title: string) => { path: string; p: number } | { failed: string }
  project?: (left: string, right: string) => number
  /** "Still on goal" for a finished turn's text; null fails. */
  onGoal?: (turn: string) => number | null
  /** The title JEV picks (a candidate, or "keep") and its probability; null fails. */
  title?: (candidates: string[]) => { pick: string; p: number } | null
}

function titleOf(text: unknown): string {
  return /Title: (.*)/.exec(String(text))?.[1] ?? ''
}

export function scriptedDecide(script: ScriptedJev, calls: DecisionRequest[]) {
  return async (request: DecisionRequest): Promise<DecisionResult | { failed: string }> => {
    calls.push(request)
    const state = request.state as Record<string, string>
    const base = { provider: 'test', model: 'test', usage: { inputTokens: 0, outputTokens: 0 } }
    const question = request.questions.folder
    if (question?.type === 'choice') {
      const answer = script.folder(titleOf(state.session))
      if ('failed' in answer) {
        return answer
      }
      const choice =
        Object.entries(question.criteria).find(([, path]) => path === answer.path)?.[0] ?? 'none'
      return {
        ...base,
        answers: {
          folder: {
            type: 'choice',
            choice,
            probabilities: { [choice]: answer.p },
            confidence: answer.p
          }
        }
      }
    }
    if (request.questions.onGoal) {
      const score = script.onGoal?.(state.second ?? '') ?? null
      return score === null
        ? { failed: 'JEV is off' }
        : { ...base, answers: { onGoal: { type: 'noul', noul: score } } }
    }
    const titleQuestion = request.questions.title
    if (titleQuestion?.type === 'choice') {
      const criteria = titleQuestion.criteria as Record<string, string>
      const answer = script.title?.(
        Object.entries(criteria)
          .filter(([id]) => id !== 'keep')
          .map(([, title]) => title)
      )
      if (!answer) {
        return { failed: 'JEV is off' }
      }
      const choice =
        answer.pick === 'keep'
          ? 'keep'
          : (Object.entries(criteria).find(
              ([id, title]) => id !== 'keep' && title === answer.pick
            )?.[0] ?? 'keep')
      return {
        ...base,
        answers: {
          title: {
            type: 'choice',
            choice,
            probabilities: { [choice]: answer.p },
            confidence: answer.p
          }
        }
      }
    }
    const noul = script.project?.(titleOf(state.first), titleOf(state.second)) ?? 0
    return { ...base, answers: { project: { type: 'noul', noul } } }
  }
}

export async function organizeHarness(
  rows: StewardOrganizeRow[],
  folders: SessionFolderEntry[],
  script: ScriptedJev
) {
  const directory = await mkdtemp(join(tmpdir(), 'steward-organize-'))
  let now = Date.parse('2026-09-26T08:00:00Z')
  let seq = 0
  const clock = () => now
  const history = new OrganizationHistoryStore({ directory: join(directory, 'history') })
  const modes: Record<StewardGuardedFeature, StewardOrganizeMode> = { refile: 'on', retitle: 'on' }
  const other: Partial<Record<StewardOrganizeFeature, StewardOrganizeMode>> = {}
  const guard = new StewardAccuracyGuard({
    directory,
    history,
    now: clock,
    switches: {
      mode: (feature) => modes[feature],
      write: (feature, mode) => {
        modes[feature] = mode
        return true
      },
      settings: () => getDefaultStewardOrganizeSettings().accuracyGuard
    }
  })
  const suggestions = new StewardSuggestionsStore({ directory, now: clock })
  const state = new StewardOrganizeState({ directory, now: clock })
  const calls: DecisionRequest[] = []
  const applied: { plan: SessionOrganizePlan; actor: SessionManageActor }[] = []
  let origins: SessionBatchOriginsSnapshot | null = { folders: {}, sessions: {} }
  const record = (patch: Omit<OrganizationRecord, 'opId' | 'phase' | 'ts'>): OrganizationRecord => {
    const entry: OrganizationRecord = {
      opId: `op-${++seq}`,
      phase: 'applied',
      ts: new Date(now).toISOString(),
      revision: `r-${seq}`,
      ...patch
    }
    history.add(entry)
    return entry
  }
  const apply = async (
    plan: SessionOrganizePlan,
    actor: SessionManageActor
  ): Promise<SessionOrganizeResult> => {
    applied.push({ plan, actor })
    const executor = executorForActor(actor)
    const extra = {
      ...(plan.reason ? { reason: plan.reason } : {}),
      ...(plan.request ? { request: plan.request } : {})
    }
    for (const create of plan.folders ?? []) {
      if (!folders.some((entry) => entry.path === create.create)) {
        const id = `new-${folders.length}`
        const section = create.create.startsWith('Saved Sessions / ') ? 'saved' : 'active'
        folders.push(folder(id, create.create, section))
        record({
          kind: 'folder.create',
          targets: [{ folderId: id }],
          value: create.create,
          executor,
          ...extra
        })
      }
    }
    const changes: SessionOrganizeResult['changes'] = []
    for (const change of plan.changes) {
      const observed = rows.find((entry) => entry.row.paneKey === change.pane)!
      const target = folders.find((entry) => entry.path === change.folder)!
      const done = record({
        kind: 'move',
        targets: [{ sessionKey: observed.row.viewKey }],
        value: target.id,
        executor,
        ...extra
      })
      observed.row = {
        ...observed.row,
        folderId: target.id,
        folder: target.path,
        saved: target.section === 'saved'
      }
      changes.push({ kind: 'move', panes: [change.pane], opId: done.opId, status: 'applied' })
    }
    return {
      dryRun: false,
      actor,
      folders: [],
      changes,
      skipped: [],
      focus: {} as SessionOrganizeResult['focus']
    }
  }
  const folderOps: SessionFolderOp[] = []
  const readings = new Map<string, StewardTitleReading>()
  const shared = new Map<string, string[]>()
  const retitles: { key: string; title: string; reason: string; expectedRevision?: string }[] = []
  const deps: StewardOrganizePassDeps = {
    now: clock,
    rows: async () => rows,
    folders: async () => folders,
    batchOrigins: async () => origins,
    history: async (key) => ({
      key,
      entries: history.entriesFor(key),
      ...history.stateFor(key),
      pending: []
    }),
    goal: async (observed) => `Work on ${observed.row.title}`,
    decide: scriptedDecide(script, calls),
    apply,
    state,
    guard,
    suggestions,
    mode: (feature) =>
      feature === 'refile' || feature === 'retitle' ? modes[feature] : (other[feature] ?? 'on'),
    pairReadsPerDay: () => 50,
    titleReading: async (observed) => readings.get(observed.row.viewKey) ?? null,
    retitle: async (observed, title, change) => {
      retitles.push({ key: observed.row.viewKey, title, ...change })
      const done = record({
        kind: 'title',
        targets: [{ sessionKey: observed.row.viewKey }],
        value: title,
        before: [observed.row.title],
        executor: { kind: 'app', feature: 'steward' },
        origin: 'generated',
        reason: change.reason
      })
      observed.row = { ...observed.row, title }
      return done.opId
    },
    sharedFiles: async (left, right) =>
      shared.get([left.row.viewKey, right.row.viewKey].toSorted().join('|')) ?? []
  }
  return {
    deps,
    rows,
    folders,
    calls,
    applied,
    modes,
    other,
    guard,
    suggestions,
    history,
    folderOps,
    readings,
    shared,
    retitles,
    record,
    advance: (ms: number) => {
      now += ms
    },
    now: clock,
    setOrigins: (next: SessionBatchOriginsSnapshot | null) => {
      origins = next
    },
    cleanup: async () => {
      await Promise.all([guard.flush(), suggestions.flush(), state.flush(), history.flush()])
      await rm(directory, { recursive: true, force: true })
    }
  }
}
