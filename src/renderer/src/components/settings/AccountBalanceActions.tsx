import { MoreHorizontal } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import type { AccountsPaneSectionModel } from './accounts-pane-types'

export function AccountBalanceActions({
  provider,
  model,
  account,
  signIn
}: {
  provider: 'claude' | 'codex'
  model: AccountsPaneSectionModel
  account: { id: string; email: string }
  signIn: () => void
}): React.JSX.Element {
  const action = provider === 'claude' ? model.claudeAction : model.codexAction
  const unavailable = model.accountRuntimeUnavailable || action !== 'idle'
  const canAdd = !unavailable
  const target = {
    runtime: model.accountRuntime.runtime,
    wslDistro: model.accountRuntime.wslDistro ?? null
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={translate('settings.accountBalances.manage', 'Manage {{email}}', {
            email: account.email
          })}
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem disabled={!canAdd} onSelect={signIn}>
          {translate('settings.accountBalances.reauthenticate', 'Sign in again')}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={unavailable}
          onSelect={() => {
            const remove =
              provider === 'claude' ? model.setRemoveClaudeTarget : model.setRemoveCodexTarget
            remove({ id: account.id, runtime: target })
          }}
        >
          {translate('auto.components.settings.AccountsPane.193131fbce', 'Remove')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
