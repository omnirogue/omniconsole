import type { WorkFolderCompany } from '../../../shared/console-work-folders-contract'
import { companyPlaceForPath } from './company-place'
import type { SidebarSession } from './sidebar-sessions'

const COMPANIES: WorkFolderCompany[] = ['OmniRogue', 'BetaCorp', 'ACME'].map((name) => ({
  id: null,
  slug: name.toLowerCase(),
  name,
  status: null,
  count: 0,
  domains: []
}))

export type SessionAutomaticTagContext = {
  home: string
  workRoot: string | null | undefined
  overrides: Record<string, string> | null | undefined
  getKnown?: (worktreeId: string) => { path: string } | null | undefined
}

/** The tag a session shows until one is chosen for it: the company its local workspace sits in. */
export function automaticSessionTag(
  session: SidebarSession,
  context: SessionAutomaticTagContext
): string | null {
  const path = session.hostId === 'local' ? context.getKnown?.(session.worktreeId)?.path : null
  return (
    companyPlaceForPath(COMPANIES, path, {
      home: context.home,
      workRoot: context.workRoot,
      overrides: context.overrides
    })?.company.slug ?? null
  )
}
