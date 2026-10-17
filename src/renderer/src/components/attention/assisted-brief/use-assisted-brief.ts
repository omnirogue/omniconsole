import { useCallback, useMemo, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { useAppStore } from '@/store'
import { reconcileBriefStarts } from '../../../../../shared/assisted-brief-start'
import type { AssistedBriefRecord, BriefClock } from '../../../../../shared/assisted-brief-types'
import { discardSavedBrief, writeSavedBrief } from './assisted-brief-memory'
import { briefTabProbeFrom, readCurrentBrief } from './assisted-brief-start-launch'
import type { BriefWorkspace } from './assisted-brief-workspace'

export type BriefTransition = (
  record: AssistedBriefRecord,
  clock: BriefClock
) => AssistedBriefRecord | null

/** 'unchanged': the transition had nothing to apply. 'failed': nothing could be saved. */
export type BriefCommitResult = 'saved' | 'unchanged' | 'failed'

type Snapshot = { record: AssistedBriefRecord | null; unreadable: boolean; loadedAt: number }

function browserStorage(): Storage {
  return window.localStorage
}

/**
 * The saved brief for this person and workspace. Every change re-reads the saved copy, applies
 * one pure transition and saves it, so two open views never overwrite each other's revisions.
 */
export function useAssistedBrief(scope: string, workspace: BriefWorkspace) {
  const [snapshot, setSnapshot] = useState<Snapshot>(() => ({
    ...readCurrentBrief(browserStorage(), scope, workspace),
    loadedAt: Date.now()
  }))
  const [saveError, setSaveError] = useState('')
  const sessionReady = useAppStore((state) => state.workspaceSessionReady)
  const tabsByWorktree = useAppStore((state) => state.tabsByWorktree)
  // Why: an uncertain start settles as soon as restored or newly opened tabs show its session.
  const record = useMemo(
    () =>
      snapshot.record &&
      reconcileBriefStarts(
        snapshot.record,
        briefTabProbeFrom(sessionReady, tabsByWorktree),
        snapshot.loadedAt
      ),
    [snapshot, sessionReady, tabsByWorktree]
  )

  const replace = useCallback((next: AssistedBriefRecord | null) => {
    setSnapshot({ record: next, unreadable: false, loadedAt: Date.now() })
  }, [])

  const save = useCallback(
    (next: AssistedBriefRecord): boolean => {
      try {
        writeSavedBrief(browserStorage(), scope, workspace.worktreeId, next)
      } catch {
        setSaveError(
          translate(
            'assistedBrief.saveFailed',
            'The brief could not be saved on this computer, so nothing changed.'
          )
        )
        return false
      }
      setSaveError('')
      replace(next)
      return true
    },
    [replace, scope, workspace.worktreeId]
  )

  const commit = useCallback(
    (transition: BriefTransition): BriefCommitResult => {
      const current = readCurrentBrief(browserStorage(), scope, workspace)
      if (!current.record) {
        setSnapshot({ ...current, loadedAt: Date.now() })
        return 'failed'
      }
      const next = transition(current.record, { now: Date.now(), newId: createBrowserUuid })
      if (!next) {
        return 'unchanged'
      }
      return save(next) ? 'saved' : 'failed'
    },
    [save, scope, workspace]
  )

  const discard = useCallback(() => {
    discardSavedBrief(browserStorage(), scope, workspace.worktreeId, record?.briefId ?? null)
    replace(null)
  }, [record?.briefId, replace, scope, workspace.worktreeId])

  return {
    record,
    unreadable: snapshot.unreadable,
    saveError,
    save,
    commit,
    replace,
    discard,
    storage: browserStorage
  }
}

export type AssistedBriefState = ReturnType<typeof useAssistedBrief>
