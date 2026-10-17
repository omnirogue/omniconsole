import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { getCompanyFolderHome } from '@/lib/company-folder-home'
import { companyPlaceForPath, type CompanyPlace } from '@/lib/company-place'
import { useAppStore } from '@/store'
import { findKnownWorktreeById } from '@/store/slices/worktrees/listing/detected-worktree-meta'
import { useWorkFolders, useWorkFoldersScope } from './use-work-folders'

// Why: a partial store (tests, early boot) must read as "unknown", not throw — and the
// fallbacks must be stable references so the shallow selector never sees a fresh object.
const EMPTY_REPOS: Record<string, never> = Object.freeze({})
const EMPTY_FOLDERS: readonly never[] = Object.freeze([])

/** The company and department a workspace sits in, or null while unknown or outside every company. */
export function useCompanyPlace(worktreeId: string | null | undefined): CompanyPlace | null {
  const folders = useWorkFolders(useWorkFoldersScope())
  const workRoot = useAppStore((state) => state.settings?.companyWorkRoot)
  const overrides = useAppStore((state) => state.settings?.companyFolders)
  const path = useAppStore(
    useShallow((state) =>
      worktreeId
        ? (findKnownWorktreeById(
            {
              worktreesByRepo: state.worktreesByRepo ?? EMPTY_REPOS,
              detectedWorktreesByRepo: state.detectedWorktreesByRepo ?? EMPTY_REPOS,
              folderWorkspaces: state.folderWorkspaces ?? EMPTY_FOLDERS
            },
            worktreeId
          )?.path ?? null)
        : null
    )
  )
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
  return useMemo(
    () => companyPlaceForPath(folders.data?.companies ?? [], path, { home, workRoot, overrides }),
    [folders.data, home, overrides, path, workRoot]
  )
}
