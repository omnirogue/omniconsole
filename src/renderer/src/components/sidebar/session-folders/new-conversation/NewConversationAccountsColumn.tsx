import { useAccountSessionCounts } from '@/hooks/useAccountSessionCounts'
import { ConversationTeamModeMenu } from './ConversationTeamModeMenu'
import { useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { DropdownMenuItem, DropdownMenuLabel } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { sortCapacityRows } from '@/lib/account-capacity-format'
import type { HoverOpenContentProps } from '@/components/next-step/use-hover-open-popover'
import type { CapacityProvider } from '../../../../../../shared/provider-account-capacity'
import type { CatalogModel } from '../../../../../../shared/agent-session-option-catalog'
import type { LaunchPick } from './resolve-launch-plan'
import { accountCanLaunch } from './resolve-launch-plan'
import { LauncherMenuRow } from './LauncherMenuRow'
import { NewConversationModelsColumn } from './NewConversationModelsColumn'
import { openLauncherAccounts } from './launcher-target'
import { launcherAccountLines } from './launcher-account-lines'
import { selectLauncherAccount } from './select-launcher-account'
import type { LauncherAccountRow } from './use-launcher-account-rows'

export function NewConversationAccountsColumn({
  agent,
  rows,
  models,
  local,
  start,
  hover
}: {
  agent: CapacityProvider
  rows: LauncherAccountRow[]
  models: CatalogModel[]
  local: boolean
  start: (pick: LaunchPick) => void
  hover: HoverOpenContentProps
}): React.JSX.Element {
  const sessionCounts = useAccountSessionCounts(rows)
  const [selecting, setSelecting] = useState(false)
  const select = async (row: LauncherAccountRow): Promise<void> => {
    if (selecting) {
      return
    }
    setSelecting(true)
    try {
      await selectLauncherAccount(row)
    } catch (error) {
      toast.error(
        translate(
          'conversationLauncher.accountUpdateFailed',
          'Could not update the default account.'
        ),
        { description: error instanceof Error ? error.message : String(error) }
      )
    } finally {
      setSelecting(false)
    }
  }
  if (!rows.length) {
    return (
      <>
        <ConversationTeamModeMenu agent={agent} />
        <DropdownMenuLabel>
          {translate('accountCapacity.checking', 'Checking usage…')}
        </DropdownMenuLabel>
      </>
    )
  }
  return (
    <>
      <ConversationTeamModeMenu agent={agent} />
      {sortCapacityRows(rows).map((row) => {
        const onOwner = local || Boolean((row as LauncherAccountRow).runtimeEnvironmentId)
        const launchable =
          onOwner &&
          (accountCanLaunch(row) || (row.state === 'checking' && row.isDefault)) &&
          !selecting
        const lines = launcherAccountLines(row)
        const content = (
          <LauncherMenuRow
            hover={hover}
            isDefault={row.isDefault}
            disabled={!onOwner || selecting || (row.state !== 'signed-out' && !launchable)}
            onDefault={
              onOwner && !selecting && row.state !== 'signed-out'
                ? () => void select(row)
                : undefined
            }
            onLaunch={() =>
              row.state === 'signed-out' ? openLauncherAccounts() : start({ agent, account: row })
            }
            submenu={
              launchable ? (
                <NewConversationModelsColumn
                  agent={agent}
                  account={row}
                  models={models}
                  start={start}
                  hover={hover}
                />
              ) : undefined
            }
          >
            {row.isSystem ? (
              <div className="text-xs text-muted-foreground">
                {translate('settings.accountBalances.system', 'System login')}
              </div>
            ) : null}
            <div className="truncate">
              {row.email ?? translate('conversationLauncher.system', 'System login')}
            </div>
            {row.detail ? <div className="text-xs text-muted-foreground">{row.detail}</div> : null}
            {local ? (
              <div
                className="text-xs text-muted-foreground tabular-nums"
                title={translate(
                  'conversationLauncher.accountSessionsHint',
                  'Active = working now. Total = open sessions on this computer. + means some sessions have an unknown account.'
                )}
              >
                {sessionCounts[row.choiceId]}
              </div>
            ) : null}
            {lines.map((line) => (
              <div key={line} className="text-xs text-muted-foreground">
                {line}
              </div>
            ))}
            {row.state === 'signed-out' ? (
              <span className="text-xs underline">
                {translate('conversationLauncher.signIn', 'Sign in')}
              </span>
            ) : null}
          </LauncherMenuRow>
        )
        return onOwner ? (
          <div key={row.choiceId}>{content}</div>
        ) : (
          <Tooltip key={row.choiceId}>
            <TooltipTrigger asChild>
              <div>{content}</div>
            </TooltipTrigger>
            <TooltipContent>
              {translate('conversationLauncher.localAccounts', 'Local accounts only')}
            </TooltipContent>
          </Tooltip>
        )
      })}
      <DropdownMenuItem onSelect={openLauncherAccounts}>
        {translate('conversationLauncher.accounts', 'Accounts & usage…')}
      </DropdownMenuItem>
    </>
  )
}
