import React from 'react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { EMPTY_SIDEBAR_LAYOUT, hiddenEntries } from '../../../../shared/sidebar-layout'
import { SidebarCustomizeMenu } from '../sidebar/SidebarCustomizeMenu'

export function SidebarArrangementSettings(): React.JSX.Element {
  const layout = useAppStore((s) => s.sidebarLayout ?? EMPTY_SIDEBAR_LAYOUT)
  const restore = useAppStore((s) => s.restoreSidebarRow)
  const entries = hiddenEntries(layout)
  return (
    <div className="space-y-3 py-3" data-sidebar-arrangement-settings="">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">
          {translate('sidebar.customize', 'Customize sidebar')}
        </span>
        <SidebarCustomizeMenu />
      </div>
      <p className="text-xs text-muted-foreground">
        {translate(
          'sidebar.settingsHelp',
          'Add shortcuts from any Settings page. Customize to drag items between Work and Agents, or remove them. Drag either sidebar edge toward the window edge to hide it; the titlebar button brings it back.'
        )}
      </p>
      {entries.map((entry) => (
        <div key={entry.id} className="flex items-center justify-between gap-2 text-sm">
          <span>{entry.label}</span>
          <Button
            size="xs"
            variant="outline"
            onClick={() => restore(entry.id)}
            aria-label={translate('sidebar.restoreRow', 'Restore {{label}}', {
              label: entry.label
            })}
          >
            {translate('sidebar.addShortcut', 'Add to sidebar')}
          </Button>
        </div>
      ))}
    </div>
  )
}
