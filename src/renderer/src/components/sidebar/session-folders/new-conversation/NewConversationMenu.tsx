import { useState } from 'react'
import { fetchProviderAccountsSnapshot } from '@/runtime/runtime-provider-accounts-client'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { nativeChatEnabledByPreference } from '../../../../../../shared/native-chat-preference'
import { AgentIcon } from '@/lib/agent-catalog'
import { formatCapacityCompact } from '@/lib/account-capacity-format'
import {
  DropdownMenuCheckboxItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import type { HoverOpenContentProps } from '@/components/next-step/use-hover-open-popover'
import type {
  AccountCapacityRow,
  CapacityProvider
} from '../../../../../../shared/provider-account-capacity'
import { sessionSidebarDensity } from '@/lib/session-sidebar-view'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { launcherUnavailableMessage } from './launcher-unavailable-message'
import { LauncherMenuRow } from './LauncherMenuRow'
import { LauncherProviderSubmenu, providerHasLaunchSubmenu } from './LauncherProviderSubmenu'
import {
  resolveLaunchPlan,
  LAUNCHER_PROVIDERS,
  type LaunchPick,
  type LauncherCapability
} from './resolve-launch-plan'
import { openLauncherAccounts, type LauncherCompany } from './launcher-target'
import { LocalOllamaLauncherRow } from './local-ollama/LocalOllamaLauncherRow'
import { OtherAgentsLauncherRow } from './OtherAgentsLauncherRow'
import { CustomizeWorkspaceRow } from './CustomizeWorkspaceRow'
import { SessionContextLauncherRow } from './SessionContextLauncherRow'
import { useActiveLaunchProject } from '@/lib/project-launch'
import { getSessionContext, launchSessionContextKey } from '@/lib/session-context-store'
import { ProjectNewWorkspaceRow } from '@/components/projects/composer-project'

export function NewConversationMenu({
  refreshCapabilities,
  capabilities,
  rows,
  local,
  accountEnvironmentId,
  hover,
  start,
  companies,
  needsCompany,
  company,
  loading,
  companiesLoading,
  companiesError,
  starting,
  launchError,
  onClose,
  onLaunched,
  launchWorktreeId = null
}: {
  refreshCapabilities: () => Promise<LauncherCapability[]>
  capabilities: LauncherCapability[]
  rows: Record<CapacityProvider, AccountCapacityRow[]>
  local: boolean
  accountEnvironmentId?: string | null
  hover: HoverOpenContentProps
  start: (pick?: LaunchPick, company?: LauncherCompany) => void
  companies: LauncherCompany[]
  needsCompany: boolean
  company?: LauncherCompany
  loading?: boolean
  companiesLoading: boolean
  companiesError: unknown
  starting?: boolean
  launchError?: string
  /** Closes the whole launcher; the Local Ollama row closes it before starting. */
  onClose?: () => void
  onLaunched?: (tabId: string) => void
  /** The target the rows above the providers describe; `null` or omitted is the Work root. */
  launchWorktreeId?: string | null
}): React.JSX.Element {
  const defaultProvider = useAppStore((state) => state.settings?.defaultTuiAgent)
  const defaults = useAppStore((state) => state.settings?.conversationLaunchDefaults)
  const chatView = useAppStore(
    (state) =>
      nativeChatEnabledByPreference(state.settings) &&
      state.settings?.openAgentTabsInChatByDefault === true
  )
  const plan = resolveLaunchPlan({
    hasTarget: true,
    local,
    accountEnvironmentId,
    capabilities,
    rows,
    defaultProvider,
    defaults
  })
  const project = useActiveLaunchProject()
  // Why read once on open: context the next session carries shows at the top level, and the row
  // does not jump out of Customize while the person adds the first item there.
  const [launchContextOnOpen] = useState(
    () => getSessionContext(launchSessionContextKey(launchWorktreeId)).length > 0
  )
  const contextOnTop = !local || !!project || launchContextOnOpen
  const compact = useSessionSidebarView((state) => sessionSidebarDensity(state.view) === 'compact')
  const [refreshing, setRefreshing] = useState(false)
  const [savingView, setSavingView] = useState(false)
  const saveChatView = async (checked: boolean): Promise<void> => {
    setSavingView(true)
    try {
      await useAppStore.getState().updateSettingsOrThrow({
        openAgentTabsInChatByDefault: checked,
        ...(checked ? { experimentalNativeChat: true } : {})
      })
    } catch {
      toast.error(translate('conversationLauncher.saveFailed', 'Could not save launch defaults.'))
    } finally {
      setSavingView(false)
    }
  }
  const refresh = async (): Promise<void> => {
    if (refreshing) {
      return
    }
    setRefreshing(true)
    try {
      await Promise.all([
        refreshCapabilities(),
        accountEnvironmentId
          ? fetchProviderAccountsSnapshot({ activeRuntimeEnvironmentId: accountEnvironmentId })
          : window.api.rateLimits
              .refresh()
              .then((rates) => useAppStore.getState().setRateLimitsFromPush(rates))
      ])
    } catch (error) {
      toast.error(translate('conversationLauncher.refreshFailed', 'Could not refresh usage.'), {
        description: error instanceof Error ? error.message : String(error)
      })
    } finally {
      setRefreshing(false)
    }
  }
  return (
    <>
      {/* Why top level in a project: what the session inherits must be seen, not tucked under Customize. */}
      {contextOnTop ? (
        <SessionContextLauncherRow hover={hover} worktreeId={launchWorktreeId} />
      ) : null}
      <ProjectNewWorkspaceRow onClose={onClose} />
      {local ? (
        <CustomizeWorkspaceRow
          hover={hover}
          launchWorktreeId={launchWorktreeId}
          onClose={onClose ?? (() => {})}
          contextRow={!contextOnTop}
        />
      ) : null}
      {needsCompany ? (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={savingView}>
            {company
              ? translate('conversationLauncher.company', 'Company: {{name}}', {
                  name: company.name
                })
              : translate('conversations.chooseCompany', 'Choose a company')}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent
            onPointerMove={hover.onPointerMove}
            onPointerEnter={hover.onPointerEnter}
            onPointerLeave={hover.onPointerLeave}
            onPointerDownCapture={hover.onPointerDownCapture}
          >
            {companies.map((company) => (
              <DropdownMenuItem
                key={company.slug ?? company.name}
                onSelect={() => start(undefined, company)}
              >
                {company.name}
              </DropdownMenuItem>
            ))}
            {companiesLoading ? (
              <DropdownMenuLabel>
                {translate('conversationLauncher.loadingCompanies', 'Loading companies…')}
              </DropdownMenuLabel>
            ) : null}
            {!companiesLoading && !companies.length ? (
              <DropdownMenuLabel>
                {companiesError
                  ? translate(
                      'conversationLauncher.companiesFailed',
                      'Companies could not be loaded.'
                    )
                  : translate('conversationLauncher.noCompanies', 'No companies available.')}
              </DropdownMenuLabel>
            ) : null}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      ) : null}
      {LAUNCHER_PROVIDERS.map((agent) => {
        const entry = capabilities.find(
          (candidate) => candidate.id === agent && candidate.status === 'usable'
        )
        if (!entry) {
          return null
        }
        if (agent === 'omp') {
          return (
            <DropdownMenuSub key={agent}>
              <DropdownMenuSubTrigger disabled={savingView || starting}>
                <AgentIcon agent={agent} size={16} />
                {translate('ompLauncher.title', 'OMP · OpenRouter')}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent
                onPointerMove={hover.onPointerMove}
                onPointerEnter={hover.onPointerEnter}
                onPointerLeave={hover.onPointerLeave}
                onPointerDownCapture={hover.onPointerDownCapture}
              >
                <LauncherProviderSubmenu
                  agent={agent}
                  entry={entry}
                  rows={rows}
                  local={local}
                  hover={hover}
                  start={start}
                  starting={starting}
                  launchError={launchError}
                />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )
        }
        const accountProvider = agent === 'claude' || agent === 'codex' ? agent : null
        const row = accountProvider
          ? rows[accountProvider].find((account) => account.isDefault)
          : undefined
        return (
          <LauncherMenuRow
            key={agent}
            disabled={savingView}
            hover={hover}
            isDefault={
              plan.kind === 'launch' &&
              (plan.agent === agent || (agent === 'claude' && plan.agent === 'claude-agent-teams'))
            }
            onDefault={() => void useAppStore.getState().updateSettings({ defaultTuiAgent: agent })}
            onLaunch={() => start({ agent })}
            submenu={
              providerHasLaunchSubmenu(agent) ? (
                <LauncherProviderSubmenu
                  agent={agent}
                  entry={entry}
                  rows={rows}
                  local={local}
                  hover={hover}
                  start={start}
                />
              ) : undefined
            }
          >
            <div className="flex items-center gap-2">
              <AgentIcon agent={agent} size={16} />
              {entry.label}
              {defaults?.[agent]?.team ? (
                <span className="text-xs text-muted-foreground">
                  {translate('conversationLauncher.teams', 'Teams')}
                </span>
              ) : null}
            </div>
            {accountProvider ? (
              <div className="truncate text-xs text-muted-foreground">
                {!local && !accountEnvironmentId ? (
                  translate(
                    'conversationLauncher.hostDefault',
                    'Uses the host’s default account · Local accounts only'
                  )
                ) : row ? (
                  <>
                    {row.email} · {formatCapacityCompact(row)}
                  </>
                ) : (
                  translate('accountCapacity.checking', 'Checking usage…')
                )}
              </div>
            ) : null}
          </LauncherMenuRow>
        )
      })}
      <LocalOllamaLauncherRow
        hover={hover}
        enabled={local && Boolean(window.api?.localOllama)}
        runner={capabilities.find((entry) => entry.id === 'opencode')}
        launchWorktreeId={launchWorktreeId}
        onClose={onClose ?? (() => {})}
        onLaunched={onLaunched}
      />
      <OtherAgentsLauncherRow
        capabilities={capabilities}
        hover={hover}
        start={start}
        disabled={savingView || starting}
      />
      {!capabilities.some(
        (entry) => entry.status === 'usable' && LAUNCHER_PROVIDERS.some((id) => id === entry.id)
      ) ? (
        <DropdownMenuLabel>{launcherUnavailableMessage(capabilities, loading)}</DropdownMenuLabel>
      ) : null}
      <DropdownMenuSeparator />
      <DropdownMenuItem
        disabled={refreshing}
        onSelect={(event) => {
          event.preventDefault()
          void refresh()
        }}
      >
        {refreshing ? <Loader2 className="size-4 animate-spin" /> : null}
        {translate('conversations.refreshAgents', 'Refresh')}
      </DropdownMenuItem>
      <DropdownMenuCheckboxItem
        checked={chatView}
        disabled={savingView}
        onSelect={(event) => event.preventDefault()}
        onCheckedChange={(checked) => void saveChatView(checked)}
      >
        {translate('conversationLauncher.chatView', 'Chat View')}
      </DropdownMenuCheckboxItem>
      <DropdownMenuCheckboxItem
        checked={compact}
        onSelect={(event) => event.preventDefault()}
        onCheckedChange={(checked) =>
          useSessionSidebarView.getState().setDensity(checked ? 'compact' : 'comfortable')
        }
      >
        {translate('conversations.compactRows', 'Compact rows')}
      </DropdownMenuCheckboxItem>
      <DropdownMenuItem onSelect={openLauncherAccounts}>
        {translate('conversationLauncher.accounts', 'Accounts & usage…')}
      </DropdownMenuItem>
    </>
  )
}
