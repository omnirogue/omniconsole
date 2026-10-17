import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { OrganizationExecutor } from '../../../shared/session-organization-change'
import {
  undoOrganizationChange,
  type OrganizationChangeDeps,
  type OrganizationUndoOutcome
} from './session-organization-change'

type PersonSurface = Extract<OrganizationExecutor, { kind: 'person' }>['via']

/** What an Undo did, in words: all of it, part of it (and why not the rest), or nothing. */
export function organizationUndoNotice(result: OrganizationUndoOutcome): {
  tone: 'success' | 'warning' | 'error'
  text: string
} {
  const failure =
    result.error ??
    (result.outcome && result.outcome.status !== 'applied' ? result.outcome.error : null)
  if (result.undone === 0) {
    if (failure) {
      return { tone: 'error', text: failure }
    }
    return result.skipped.length > 0 &&
      result.skipped.every((entry) => entry.status === 'not-undoable')
      ? {
          tone: 'warning',
          text: translate('conversations.history.undoNotPossible', 'This change cannot be undone.')
        }
      : {
          tone: 'warning',
          text: translate(
            'conversations.history.undoNone',
            'Nothing was undone: it changed since, so it was left as it is.'
          )
        }
  }
  if (result.skipped.length > 0) {
    return {
      tone: 'warning',
      text: translate(
        'conversations.history.undoPartial',
        'Undid {{undone}} of {{total}}; {{skipped}} changed since, so they were left as they are.',
        { undone: result.undone, total: result.total, skipped: result.skipped.length }
      )
    }
  }
  return {
    tone: 'success',
    text: translate('conversations.history.undone', 'Undone')
  }
}

/** Undo from main's record, then say what happened; a target changed since is never overwritten. */
export async function undoOrganizationChangeWithNotice(
  opId: string,
  via: PersonSurface,
  deps: OrganizationChangeDeps = {}
): Promise<OrganizationUndoOutcome> {
  const result = await undoOrganizationChange(opId, { ...deps, via })
  const notice = organizationUndoNotice(result)
  toast[notice.tone](notice.text)
  return result
}

/**
 * Undo a group of changes (one request's run), newest first so each Undo meets the state the
 * next-newer one left; one notice for the whole group.
 */
export async function undoOrganizationChangesWithNotice(
  opIds: readonly string[],
  via: PersonSurface,
  deps: OrganizationChangeDeps = {}
): Promise<OrganizationUndoOutcome> {
  const total: OrganizationUndoOutcome = { undone: 0, total: 0, skipped: [] }
  for (const opId of opIds) {
    const result = await undoOrganizationChange(opId, { ...deps, via })
    total.undone += result.undone
    total.total += result.total
    total.skipped.push(...result.skipped)
    if (result.error) {
      total.error ??= result.error
    }
    if (result.outcome && result.outcome.status !== 'applied') {
      total.outcome ??= result.outcome
    }
  }
  const notice = organizationUndoNotice(total)
  toast[notice.tone](notice.text)
  return total
}
