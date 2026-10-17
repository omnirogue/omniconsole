import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useWorkFolders, useWorkFoldersScope } from '@/components/companies/use-work-folders'
import { getCompanyFolderHome } from '@/lib/company-folder-home'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { inferTaskFromSession } from '@/lib/task-inference'
import { useAppStore } from '@/store'
import type { TaskDetailsDraft } from '../../../../shared/task-details'
import { findKnownWorktreeById } from '@/store/slices/worktrees/listing/detected-worktree-meta'
import type {
  WorkFolderCompany,
  WorkFolderDomain,
  WorkFolderProject
} from '../../../../shared/console-work-folders-contract'

export type TaskDraft = TaskDetailsDraft & {
  /** The company the hub files the card under; the department and project belong to it. */
  companyId: string
  /** Other companies the work is for, recorded as `company:<slug>` tags on the card. */
  additionalCompanyIds: string[]
  unitId: string
  goalId: string
  projectId: string
  people: string[]
  /** An idea for the Kanban's Proposed lane rather than committed work. */
  proposed: boolean
}

export type TaskFiling = {
  companyId?: string | null
  companySlug?: string | null
  additionalCompanyIds?: readonly string[] | null
  unitId?: string | null
  goalId?: string | null
  projectId?: string | null
  proposed?: boolean | null
}

const EMPTY_REPOS: Record<string, never> = Object.freeze({})
const EMPTY_FOLDERS: readonly never[] = Object.freeze([])

/**
 * The form a person corrects rather than fills: the conversation's name and the place
 * its folder sits in, already chosen, with the lists needed to change any of it.
 */
export function useTaskDraft(
  session: SidebarSession | null,
  initialFiling?: TaskFiling
): {
  draft: TaskDraft
  set: (next: Partial<TaskDraft>) => void
  companies: readonly WorkFolderCompany[]
  departments: readonly WorkFolderDomain[]
  projects: readonly WorkFolderProject[]
  cwd: string | null
  loading: boolean
  inferredPlace: boolean
} {
  const folders = useWorkFolders(useWorkFoldersScope())
  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)
  const workRoot = useAppStore((state) => state.settings?.companyWorkRoot)
  const overrides = useAppStore((state) => state.settings?.companyFolders)
  const worktreeState = useAppStore(
    useShallow((state) => ({
      worktreesByRepo: state.worktreesByRepo ?? EMPTY_REPOS,
      detectedWorktreesByRepo: state.detectedWorktreesByRepo ?? EMPTY_REPOS,
      folderWorkspaces: state.folderWorkspaces ?? EMPTY_FOLDERS
    }))
  )
  const cwd = useMemo(() => {
    const id = session?.worktreeId ?? activeWorktreeId
    return id ? (findKnownWorktreeById(worktreeState, id)?.path ?? null) : null
  }, [session, activeWorktreeId, worktreeState])
  const [home, setHome] = useState('')
  useEffect(() => {
    let live = true
    void getCompanyFolderHome().then((value) => {
      if (live) {
        setHome(value)
      }
    })
    return () => {
      live = false
    }
  }, [])
  // Why: a fresh [] every render would re-run the inference (and re-seed the form) forever.
  const companies = folders.data?.companies ?? EMPTY_FOLDERS
  const inferred = useMemo(
    () =>
      inferTaskFromSession({
        conversationTitle: session?.label ?? '',
        path: cwd,
        companies,
        home,
        workRoot,
        overrides
      }),
    [companies, cwd, home, overrides, session, workRoot]
  )
  // Untouched defaults can finish loading without replacing the person's edits.
  const [draft, setDraft] = useState<Partial<TaskDraft>>({})
  const proposed = initialFiling?.proposed === true
  const companyId =
    initialFiling?.companyId ??
    companies.find(
      (company) => company.slug?.toLowerCase() === initialFiling?.companySlug?.trim().toLowerCase()
    )?.id ??
    inferred.place?.company.id ??
    ''
  const place = inferred.place?.company.id === companyId ? inferred.place : null
  const current: TaskDraft = {
    title: inferred.title,
    description: '',
    dueDate: '',
    priority: 'normal',
    sequentialSteps: [],
    companyId,
    additionalCompanyIds: [...(initialFiling?.additionalCompanyIds ?? [])],
    unitId: initialFiling?.unitId ?? place?.domain?.id ?? '',
    goalId: initialFiling?.goalId ?? '',
    projectId: initialFiling?.projectId ?? place?.project?.id ?? '',
    people: [],
    proposed,
    ...draft
  }
  const departments =
    companies.find((company) => company.id === current.companyId)?.domains ?? EMPTY_FOLDERS
  const projects =
    departments.find((department) => department.id === current.unitId)?.projects ?? EMPTY_FOLDERS
  return {
    draft: current,
    set: (next) => {
      setDraft((previous) => {
        const before = { ...current, ...previous }
        const merged = { ...previous, ...next }
        // Why: a department or project from another company is a filing the hub refuses,
        // and the primary company is never also an "also for" company.
        return next.companyId !== undefined && next.companyId !== before.companyId
          ? {
              ...merged,
              unitId: '',
              goalId: '',
              projectId: '',
              additionalCompanyIds: (
                merged.additionalCompanyIds ?? before.additionalCompanyIds
              ).filter((id) => id !== next.companyId)
            }
          : next.unitId !== undefined && next.unitId !== before.unitId
            ? { ...merged, goalId: '', projectId: '' }
            : merged
      })
    },
    companies,
    departments,
    projects,
    cwd,
    loading: folders.loading && !folders.data,
    inferredPlace: Boolean(inferred?.place)
  }
}
