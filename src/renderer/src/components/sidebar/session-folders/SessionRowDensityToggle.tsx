import { Checkbox } from '@/components/ui/checkbox'
import { translate } from '@/i18n/i18n'
import { sessionSidebarDensity } from '@/lib/session-sidebar-view'
import { useSessionSidebarView } from '@/store/session-sidebar-view'

/**
 * "Compact rows" in the Conversations ⌄ menu: checked, every row is one line and its details wait
 * in the hover card; unchecked, rows show their agent and status line again. Per device.
 */
export function SessionRowDensityToggle(): React.JSX.Element {
  const compact = useSessionSidebarView((state) => sessionSidebarDensity(state.view) === 'compact')
  const label = translate('conversations.compactRows', 'Compact rows')
  return (
    <label
      className="flex cursor-pointer items-center gap-2 border-t pt-3 text-xs text-muted-foreground"
      data-session-density-toggle=""
    >
      <Checkbox
        checked={compact}
        aria-label={label}
        onCheckedChange={(checked) =>
          useSessionSidebarView.getState().setDensity(checked === true ? 'compact' : 'comfortable')
        }
      />
      {label}
    </label>
  )
}
