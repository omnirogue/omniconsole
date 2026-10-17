import { useSettingsNavigationMetadata } from '@/hooks/useSettingsNavigationMetadata'
import { isSettingsNavigationTarget } from '@/lib/settings-navigation-types'
import { useAppStore } from '@/store'
import { EMPTY_SIDEBAR_LAYOUT } from '../../../../shared/sidebar-layout'
import { sidebarMemberScope } from '../../../../shared/sidebar-navigation-placement'
import { SIDEBAR_NAV_ROW_CLASS } from './SidebarNavMemberButton'
import type { OrderedSidebarItem } from './SidebarOrderedGroup'

export function useSidebarSettingsItems(): OrderedSidebarItem[] {
  const sections = useSettingsNavigationMetadata()
  const layout = useAppStore((s) => s.sidebarLayout ?? EMPTY_SIDEBAR_LAYOUT)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  return sections.flatMap((section) => {
    const id = `settings:${section.id}`
    const target = { pane: section.id, repoId: null }
    if (!sidebarMemberScope(layout, id, null) || !isSettingsNavigationTarget(target)) {
      return []
    }
    const Icon = section.icon
    return [
      {
        id,
        label: section.title,
        node: (
          <button
            type="button"
            className={SIDEBAR_NAV_ROW_CLASS}
            onClick={() => {
              openSettingsTarget(target)
              openSettingsPage()
            }}
          >
            <Icon className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{section.title}</span>
          </button>
        )
      }
    ]
  })
}
