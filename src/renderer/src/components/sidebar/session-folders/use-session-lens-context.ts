import { useMemo } from 'react'
import { COMPANY_NAME } from '../../../../../shared/company-identity'
import { conversationViewKey } from '@/lib/conversation-view'
import type { SessionSidebarLensContext } from '@/lib/session-sidebar-lens'
import { sessionSidebarLens } from '@/lib/session-sidebar-lens'
import { defaultSessionTags } from '@/lib/session-tags'
import type { SessionSidebarView } from '@/lib/session-sidebar-view'
import { useSessionBatchOrigins } from '@/store/session-batch-origins'
import { useSessionTags } from '@/store/session-tags'
import type { SidebarHostOption } from '../sidebar-host-options'

const COMPANY_TAG_IDS = new Set([
  ...Object.keys(COMPANY_NAME),
  ...defaultSessionTags().tags.map((tag) => tag.id)
])

/**
 * What the Group-by views read besides the rows: batch origins for "request", host names for
 * "computer", company tags for "company". Undefined while the list groups by status or task, so
 * those views never rebuild for it.
 */
export function useSessionLensContext(args: {
  view: Pick<SessionSidebarView, 'lens'>
  hostOptions: readonly Pick<SidebarHostOption, 'id' | 'label' | 'health'>[]
  tagIds: ReadonlyMap<string, readonly string[]>
}): SessionSidebarLensContext | undefined {
  const lens = sessionSidebarLens(args.view)
  const origins = useSessionBatchOrigins((state) => state.data)
  const tags = useSessionTags((state) => state.data.tags)
  const { hostOptions, tagIds } = args
  return useMemo(() => {
    if (!lens) {
      return undefined
    }
    const companies = tags.filter((tag) => COMPANY_TAG_IDS.has(tag.id))
    return {
      origins,
      hosts: new Map(
        hostOptions.map((host) => [
          host.id,
          { label: host.label, reachable: host.health === 'local' || host.health === 'available' }
        ])
      ),
      companyOf: (session) => {
        const ids = tagIds.get(conversationViewKey(session)) ?? []
        const tag = companies.find((company) => ids.includes(company.id))
        return tag ? { id: tag.id, label: tag.name } : null
      }
    }
  }, [lens, origins, tags, hostOptions, tagIds])
}
