/**
 * "Make this a project" (Phase 3 §4): a batch folder session prep made more than a day ago that
 * still holds three or more sessions with work in the last day earns one `project` suggestion.
 * On the person's Yes in Work, its sessions move into `Saved Sessions / <name>`, recorded as
 * `app/steward` with the request `accepted in Work`, so their placement stays the steward's and
 * Tier 2 may still archive them.
 */

import { deriveGeneratedTabTitle } from '../../../shared/agent-tab-title'
import type { SessionBatchOriginsSnapshot } from '../../../shared/session-batch-origin'
import { SAVED_SESSIONS_LABEL } from '../../../shared/session-folder-ref'
import type { SessionOrganizePlan } from '../../../shared/session-organize'
import type { SessionFolderEntry } from '../../../shared/session-folder-cli'
import type { StewardSuggestion } from '../../../shared/session-steward-suggestions'
import { latestRevision, stewardSessionTarget, type StewardOrganizeDeps } from './steward-refile'
import type { StewardOrganizeRow } from './steward-refile-candidates'
import type { StewardSuggestionAcceptor } from './steward-suggestion-accept'

const HOUR_MS = 60 * 60 * 1000
export const STEWARD_PROJECT_MIN_SESSIONS = 3
/** The batch is at least this old, and had work this recently. */
export const STEWARD_PROJECT_AGE_MS = 24 * HOUR_MS
export const STEWARD_PROJECT_ACTIVE_MS = 24 * HOUR_MS
const NAME_MAX = 60

export type StewardProjectProposal = { folderId: string; folderPath: string; name: string }

const ACTIVE_STATES = new Set(['working', 'queued', 'awaiting-user', 'waiting-for-yes'])

function members(rows: readonly StewardOrganizeRow[], folderId: string): StewardOrganizeRow[] {
  return rows.filter((observed) => observed.row.folderId === folderId && !observed.row.archived)
}

function projectName(request: string, rows: readonly StewardOrganizeRow[], folder: string): string {
  const repos = new Set(rows.map((observed) => observed.row.repoLabel).filter(Boolean))
  const name =
    deriveGeneratedTabTitle(request) ?? (repos.size === 1 ? [...repos][0]! : null) ?? folder
  return name.replaceAll('/', '-').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).trim()
}

export function stewardProjectPairKey(folderId: string): string {
  return `project:folder:${folderId}`
}

/** Proposes (or keeps open) one suggestion per qualifying batch folder; returns their ids. */
export async function proposeStewardProjects(
  deps: Pick<StewardOrganizeDeps, 'now' | 'mode' | 'suggestions'>,
  rows: readonly StewardOrganizeRow[],
  folders: readonly SessionFolderEntry[],
  origins: SessionBatchOriginsSnapshot | null
): Promise<string[]> {
  if (!origins || deps.mode('projectSuggestions') !== 'on') {
    return []
  }
  const now = deps.now()
  const proposed: string[] = []
  for (const origin of Object.values(origins.folders)) {
    const folder = folders.find((entry) => entry.id === origin.folderId)
    if (!folder || folder.section !== 'active' || now - origin.createdAt < STEWARD_PROJECT_AGE_MS) {
      continue
    }
    const inside = members(rows, folder.id)
    const active = inside.some(
      (observed) =>
        ACTIVE_STATES.has(observed.entry.state) ||
        now - (observed.entry.lastActivityAt ?? 0) < STEWARD_PROJECT_ACTIVE_MS
    )
    if (inside.length < STEWARD_PROJECT_MIN_SESSIONS || !active) {
      continue
    }
    const name = projectName(origin.requestExcerpt, inside, folder.name)
    const suggestion = await deps.suggestions.propose({
      kind: 'project',
      targets: inside.map(stewardSessionTarget),
      proposal: {
        folderId: folder.id,
        folderPath: folder.path,
        name
      } satisfies StewardProjectProposal,
      title: `Make “${folder.path}” a project?`,
      evidence: `${inside.length} sessions, still at work after a day; moves them to ${SAVED_SESSIONS_LABEL} / ${name}`,
      pairKey: stewardProjectPairKey(folder.id)
    })
    if (suggestion) {
      proposed.push(suggestion.id)
    }
  }
  return proposed
}

function proposalOf(suggestion: StewardSuggestion): StewardProjectProposal {
  const value = suggestion.proposal as Partial<StewardProjectProposal> | null
  if (!value || typeof value.folderId !== 'string' || typeof value.name !== 'string') {
    throw new Error('This project suggestion is damaged. Nothing changed.')
  }
  return { folderId: value.folderId, folderPath: value.folderPath ?? '', name: value.name }
}

/** The Yes: every session still in the batch folder moves into the new Saved project folder. */
export function stewardProjectAcceptor(
  deps: Pick<StewardOrganizeDeps, 'rows' | 'history' | 'apply'>
): StewardSuggestionAcceptor {
  return async (suggestion, { actor, request }) => {
    const proposal = proposalOf(suggestion)
    const inside = members(await deps.rows(), proposal.folderId).filter(
      (observed) => observed.row.paneKey !== null
    )
    if (inside.length === 0) {
      throw new Error(`“${proposal.folderPath}” has no sessions left to move. Nothing changed.`)
    }
    const path = `${SAVED_SESSIONS_LABEL} / ${proposal.name}`
    const changes: SessionOrganizePlan['changes'] = []
    for (const observed of inside) {
      changes.push({
        pane: observed.row.paneKey!,
        folder: path,
        expectedRevision: latestRevision(await deps.history(observed.row.viewKey))
      })
    }
    const result = await deps.apply(
      {
        reason: `made “${proposal.folderPath}” a project`,
        request,
        folders: [{ create: path }],
        changes
      },
      actor
    )
    const moved = result.changes
      .filter((change) => change.kind === 'move' && change.status === 'applied')
      .reduce((sum, change) => sum + change.panes.length, 0)
    if (moved === 0) {
      const error =
        result.changes.find((change) => change.error)?.error ?? result.skipped[0]?.reason
      throw new Error(`Nothing moved${error ? `: ${error}` : ''}.`)
    }
    return { summary: `Moved ${moved} session${moved === 1 ? '' : 's'} into ${path}.` }
  }
}
