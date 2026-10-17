import type {
  AccountCapacityRow,
  CapacityProvider
} from '../../../../../../shared/provider-account-capacity'
import type { LauncherCapability } from './resolve-launch-plan'
import type { LauncherCompany } from './launcher-target'

export type ConversationLaunchInput = {
  worktreeId: string | null
  defaultToWorkRoot?: boolean
  company?: LauncherCompany
  scope: string
  local: boolean
  accountEnvironmentId?: string | null
  rows: Record<CapacityProvider, AccountCapacityRow[]>
  readCapabilities: () => LauncherCapability[]
  open?: boolean
  loading?: boolean
  refreshCapabilities?: () => Promise<LauncherCapability[]>
  setOpen: (open: boolean) => void
  /** Called with the new conversation's tab the moment it exists (a folder "+" files it). */
  onLaunched?: (tabId: string) => void
  /** The view the new tab opens in; the launcher's own preference when absent. */
  viewModePreference?: 'chat' | 'terminal'
}
