import React from 'react'
import { Pin, PinOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { isSettingsNavigationTarget } from '@/lib/settings-navigation-types'
import { EMPTY_SIDEBAR_LAYOUT, isHidden } from '../../../../shared/sidebar-layout'
import { sidebarMemberScope } from '../../../../shared/sidebar-navigation-placement'

export function SidebarPinControl({
  sectionId,
  title
}: {
  sectionId: string
  title: string
}): React.JSX.Element | null {
  const layout = useAppStore((s) => s.sidebarLayout ?? EMPTY_SIDEBAR_LAYOUT)
  const move = useAppStore((s) => s.moveSidebarMember)
  const hide = useAppStore((s) => s.hideSidebarRow)
  if (!isSettingsNavigationTarget({ pane: sectionId, repoId: null })) {
    return null
  }
  const id = `settings:${sectionId}`
  const scope = sidebarMemberScope(layout, id, null)
  const pinned = scope !== null && !isHidden(layout, id)
  return (
    <Button
      size="sm"
      variant="ghost"
      aria-pressed={pinned}
      onClick={() => {
        if (pinned) {
          hide(id, title)
        } else {
          move(id, scope ?? 'nav:agents', layout.orders[scope ?? 'nav:agents'] ?? [])
        }
      }}
    >
      {pinned ? <PinOff /> : <Pin />}
      {pinned
        ? translate('sidebar.removeShortcut', 'Remove from sidebar')
        : translate('sidebar.addShortcut', 'Add to sidebar')}
    </Button>
  )
}
