import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { EMPTY_SIDEBAR_LAYOUT } from '../../../../shared/sidebar-layout'
import { MAX_SIDEBAR_GROUPS } from '../../../../shared/sidebar-custom-groups'
import { useSidebarGroupsSupport } from './use-sidebar-groups-support'

export function SidebarGroupSettings(): React.JSX.Element {
  const layout = useAppStore((state) => state.sidebarLayout ?? EMPTY_SIDEBAR_LAYOUT)
  const create = useAppStore((state) => state.createSidebarGroup)
  const remove = useAppStore((state) => state.deleteSidebarGroup)
  const [name, setName] = useState('')
  const supported = useSidebarGroupsSupport()
  const groups = layout.groups ?? []
  const duplicate = groups.some((group) => group.name.toLowerCase() === name.trim().toLowerCase())
  const canCreate =
    supported && name.trim() !== '' && !duplicate && groups.length < MAX_SIDEBAR_GROUPS
  return (
    <div className="space-y-2 border-t pt-2">
      <p className="font-medium">{translate('sidebar.customGroups', 'Custom groups')}</p>
      {!supported ? (
        <p className="text-muted-foreground">
          {translate(
            'sidebar.groupsUpdateRequired',
            'Update the connected server to create sidebar groups.'
          )}
        </p>
      ) : null}
      {groups.map((group) => (
        <div key={group.id} className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate">{group.name}</span>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => remove(group.id)}
            aria-label={translate('sidebar.deleteGroup', 'Delete group {{name}}', {
              name: group.name
            })}
          >
            <Trash2 className="size-3" aria-hidden />
          </Button>
        </div>
      ))}
      <form
        className="flex items-center gap-1"
        onSubmit={(event) => {
          event.preventDefault()
          if (canCreate) {
            create(name)
            setName('')
          }
        }}
      >
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={80}
          aria-label={translate('sidebar.groupName', 'Group name')}
          placeholder={translate('sidebar.groupName', 'Group name')}
          className="h-7 min-w-0 text-xs"
        />
        <Button variant="outline" size="xs" type="submit" disabled={!canCreate}>
          <Plus className="size-3" aria-hidden />
          {translate('sidebar.createGroup', 'Create group')}
        </Button>
      </form>
      <p className="text-[11px] text-muted-foreground">
        {translate(
          'sidebar.groupHelp',
          'Move shortcuts into a group using their menu or drag handles. Deleting a group returns its shortcuts to Work or Agents.'
        )}
      </p>
    </div>
  )
}
