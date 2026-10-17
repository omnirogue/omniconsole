import type React from 'react'
import { Bot, BotOff } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { refreshSessionHostsStatus, useSessionHostsSnapshot } from '@/lib/session-hosts-client'
import { useSessionHostControlWrite, withAutomation } from '@/lib/session-host-control-write'
import { useAppStore } from '@/store'

/**
 * A folder's automation override: off stops automatic actions on its sessions on every computer
 * that runs one (it syncs), and never relaxes a hard stop.
 */
export function SessionFolderAutomationItem({ folderId }: { folderId: string }): React.JSX.Element {
  const status = useSessionHostsSnapshot()
  const local = useAppStore(
    (state) => state.settings?.sessionHostControl?.folderPolicies?.[folderId]
  )
  const { write } = useSessionHostControlWrite()
  // Why the reading first: another Mac's newer override is the account's value.
  const off = (status ? status.folderPolicies[folderId] : local)?.automation === 'off'
  return (
    <DropdownMenuItem
      data-folder-automation={off ? 'off' : 'on'}
      onSelect={() => {
        void write((latest) => ({
          folderPolicies: withAutomation(latest.folderPolicies, folderId, !off)
        })).then(() => refreshSessionHostsStatus())
      }}
    >
      {off ? <Bot className="size-3.5" /> : <BotOff className="size-3.5" />}
      {off
        ? translate('sessionHosts.folderAllowAutomation', 'Allow automatic actions here')
        : translate('sessionHosts.folderNoAutomation', 'No automatic actions here')}
    </DropdownMenuItem>
  )
}
