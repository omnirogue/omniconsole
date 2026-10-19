import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { Label } from '../ui/label'
import { Switch } from '../ui/switch'
import { useAppStore } from '../../store'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch } from './settings-search'
import { getExperimentalPaneSearchEntries, getExperimentalSearchEntry } from './experimental-search'
import { HiddenExperimentalGroup } from './HiddenExperimentalGroup'
import { NumberField, SettingsSwitch, SettingsSwitchRow } from './SettingsFormControls'
import { translate } from '@/i18n/i18n'
import { NativeChatExperimentalSetting } from './NativeChatExperimentalSetting'
import { AgentDashboardExperimentalSetting } from './AgentDashboardExperimentalSetting'
import { EphemeralVmsExperimentalSetting } from './EphemeralVmsExperimentalSetting'
import { OmniSiPreviewsExperimentalSetting } from './OmniSiPreviewsExperimentalSetting'
import { IdleAutoCloseExperimentalSetting } from './IdleAutoCloseExperimentalSetting'
import { CommandCenterExperimentalSetting } from './CommandCenterExperimentalSetting'
import { resolveAgentSleepPolicy } from '@/lib/agent-sleep-policy'
import {
  MAX_AGENT_HIBERNATION_IDLE_MS,
  MIN_AGENT_HIBERNATION_IDLE_MS,
  getEffectiveAgentHibernationIdleMs
} from '@/lib/agent-hibernation-planner'

export { getExperimentalPaneSearchEntries }

const MS_PER_MINUTE = 60 * 1000

type ExperimentalPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  /** Hidden-experimental group is only rendered once the user has unlocked
   *  it via Option-clicking the Experimental page title. */
  hiddenExperimentalUnlocked?: boolean
}

export function ExperimentalPane({
  settings,
  updateSettings,
  hiddenExperimentalUnlocked = false
}: ExperimentalPaneProps): React.JSX.Element {
  const searchQuery = useAppStore((s) => s.settingsSearchQuery)
  const showPet = matchesSettingsSearch(searchQuery, [getExperimentalSearchEntry().pet])
  const showAgentsView = matchesSettingsSearch(searchQuery, [
    getExperimentalSearchEntry().agentsView
  ])
  const showAgentDashboard = matchesSettingsSearch(searchQuery, [
    getExperimentalSearchEntry().agentDashboard
  ])
  const showNativeChat = matchesSettingsSearch(searchQuery, [
    getExperimentalSearchEntry().nativeChat
  ])
  const showTerminalAttention = matchesSettingsSearch(searchQuery, [
    getExperimentalSearchEntry().terminalAttention
  ])
  const showAgentHibernation = matchesSettingsSearch(searchQuery, [
    getExperimentalSearchEntry().agentHibernation
  ])
  const showIdleAutoClose = matchesSettingsSearch(searchQuery, [
    getExperimentalSearchEntry().idleAutoClose
  ])
  const showNewWorktreeCardStyle = matchesSettingsSearch(searchQuery, [
    getExperimentalSearchEntry().newWorktreeCardStyle
  ])
  const agentHibernationEnabled = settings.experimentalAgentHibernation === true
  const newWorktreeCardStyleEnabled = settings.experimentalNewWorktreeCardStyle === true
  // Why: the planner owns ms-based bounds/defaults; the UI edits minutes
  // while displaying the same effective clamped value the planner will use.
  const agentHibernationIdleMinutes = Math.round(
    getEffectiveAgentHibernationIdleMs(settings.agentHibernationIdleMs) / MS_PER_MINUTE
  )

  return (
    <div className="space-y-4">
      <CommandCenterExperimentalSetting settings={settings} updateSettings={updateSettings} />
      {showPet ? (
        <SearchableSetting
          title={translate('auto.components.settings.ExperimentalPane.dd6f0a1d45', 'Pet')}
          description={translate(
            'auto.components.settings.ExperimentalPane.0e89a574ae',
            'Floating animated pet in the bottom-right corner.'
          )}
          keywords={getExperimentalSearchEntry().pet.keywords}
          className="space-y-3 py-2"
          id="experimental-pet"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 shrink space-y-1.5">
              <Label>
                {translate('auto.components.settings.ExperimentalPane.dd6f0a1d45', 'Pet')}
              </Label>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.ExperimentalPane.ca2219fe5e',
                  'Shows a small animated pet pinned to the bottom-right corner. Pick a character (Claudino, OpenCode, Gremlin) or upload your own PNG, APNG, GIF, WebP, JPG, or SVG from the status-bar pet menu. Hide it any time from the same menu without disabling this setting.'
                )}
              </p>
            </div>
            <Switch
              aria-label={translate('auto.components.settings.ExperimentalPane.dd6f0a1d45', 'Pet')}
              checked={settings.experimentalPet}
              onCheckedChange={(checked) => {
                updateSettings({ experimentalPet: checked })
              }}
            />
          </div>
        </SearchableSetting>
      ) : null}

      {showAgentsView ? (
        <SearchableSetting
          title={translate('auto.components.settings.ExperimentalPane.a05bcdaf57', 'Agents View')}
          description={translate(
            'auto.components.settings.ExperimentalPane.f63ea281e3',
            'Threaded left-sidebar feed for agent completions and blocking states.'
          )}
          keywords={getExperimentalSearchEntry().agentsView.keywords}
          className="space-y-3 py-2"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 shrink space-y-0.5">
              <Label>
                {translate('auto.components.settings.ExperimentalPane.a05bcdaf57', 'Agents View')}
              </Label>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.ExperimentalPane.0277901cf7',
                  'Adds an Agents entry to the left sidebar with a threaded worktree feed for completed agents, blocking questions, unread state, and worktree creation events. Experimental — the event model and UI may change.'
                )}
              </p>
            </div>
            <Switch
              aria-label={translate(
                'auto.components.settings.ExperimentalPane.a05bcdaf57',
                'Agents View'
              )}
              checked={settings.experimentalActivity}
              onCheckedChange={(checked) =>
                updateSettings({
                  experimentalActivity: checked
                })
              }
            />
          </div>
        </SearchableSetting>
      ) : null}

      {showAgentDashboard ? (
        <AgentDashboardExperimentalSetting settings={settings} updateSettings={updateSettings} />
      ) : null}

      {showNativeChat ? (
        <NativeChatExperimentalSetting settings={settings} updateSettings={updateSettings} />
      ) : null}

      {showTerminalAttention ? (
        <SearchableSetting
          title={translate(
            'auto.components.settings.ExperimentalPane.ec897e8d89',
            'Terminal attention'
          )}
          description={translate(
            'auto.components.settings.ExperimentalPane.88b7613afb',
            'Persistent pane highlight for terminal bell and agent-completion events.'
          )}
          keywords={getExperimentalSearchEntry().terminalAttention.keywords}
          className="space-y-3 py-2"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 shrink space-y-0.5">
              <Label>
                {translate(
                  'auto.components.settings.ExperimentalPane.ec897e8d89',
                  'Terminal attention'
                )}
              </Label>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.ExperimentalPane.a20d5ea365',
                  'Keeps a pane-level highlight visible after terminal bell or agent-completion events until you interact with that pane. Experimental while we tune the signal.'
                )}
              </p>
            </div>
            <Switch
              aria-label={translate(
                'auto.components.settings.ExperimentalPane.ec897e8d89',
                'Terminal attention'
              )}
              checked={settings.experimentalTerminalAttention}
              onCheckedChange={(checked) =>
                updateSettings({
                  experimentalTerminalAttention: checked
                })
              }
            />
          </div>
        </SearchableSetting>
      ) : null}

      {showAgentHibernation ? (
        <SearchableSetting
          title={translate(
            'auto.components.settings.ExperimentalPane.agentHibernation.title',
            'Agent sleep'
          )}
          description={translate(
            'auto.components.settings.ExperimentalPane.agentHibernation.description',
            'Stops idle background agent terminals after the configured idle window and resumes supported sessions when you open them again.'
          )}
          keywords={getExperimentalSearchEntry().agentHibernation.keywords}
          className="space-y-3 py-2"
          id="experimental-agent-hibernation"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 shrink space-y-0.5">
              <Label>
                {translate(
                  'auto.components.settings.ExperimentalPane.agentHibernation.title',
                  'Agent sleep'
                )}
              </Label>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.ExperimentalPane.agentHibernation.copy',
                  'Stops idle background agent terminals after the configured idle window and resumes supported sessions when you open them again. Agent sleep preserves launch options for agents started by OmniConsole. Manually started agents may resume with your current OmniConsole defaults. Experimental while we tune the safety model.'
                )}
              </p>
            </div>
            <SettingsSwitch
              checked={agentHibernationEnabled}
              ariaLabel={translate(
                'auto.components.settings.ExperimentalPane.agentHibernation.toggleLabel',
                'Toggle agent sleep'
              )}
              onChange={() =>
                updateSettings({
                  experimentalAgentHibernation: !agentHibernationEnabled
                })
              }
            />
          </div>
          {agentHibernationEnabled && !resolveAgentSleepPolicy(settings)?.act ? (
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.ExperimentalPane.agentHibernation.governedByIdleAutoClose',
                'Idle auto-close governs Agent sleep: in Shadow it only logs what it would sleep, Off stops it, and On sleeps agents once the restore flood guard is on.'
              )}
            </p>
          ) : null}
          {agentHibernationEnabled ? (
            <NumberField
              label={translate(
                'auto.components.settings.ExperimentalPane.agentHibernation.idleMinutesLabel',
                'Sleep after'
              )}
              description={translate(
                'auto.components.settings.ExperimentalPane.agentHibernation.idleMinutesDescription',
                'How many idle minutes a completed background agent must wait before OmniConsole can sleep it.'
              )}
              value={agentHibernationIdleMinutes}
              min={MIN_AGENT_HIBERNATION_IDLE_MS / MS_PER_MINUTE}
              max={MAX_AGENT_HIBERNATION_IDLE_MS / MS_PER_MINUTE}
              step={1}
              suffix={translate(
                'auto.components.settings.ExperimentalPane.agentHibernation.idleMinutesSuffix',
                'minutes'
              )}
              onChange={(minutes) =>
                updateSettings({
                  // Why: settings persist the planner contract, not the display unit.
                  agentHibernationIdleMs: minutes * MS_PER_MINUTE
                })
              }
            />
          ) : null}
        </SearchableSetting>
      ) : null}

      {showIdleAutoClose ? (
        <IdleAutoCloseExperimentalSetting settings={settings} updateSettings={updateSettings} />
      ) : null}

      {showNewWorktreeCardStyle ? (
        <SearchableSetting
          title={translate(
            'auto.components.settings.ExperimentalPane.newWorktreeCardStyle.title',
            'New card style'
          )}
          description={translate(
            'auto.components.settings.ExperimentalPane.newWorktreeCardStyle.description',
            'Preview updated worktree-card layout, metadata placement, card-display menu options, and status presentation.'
          )}
          keywords={getExperimentalSearchEntry().newWorktreeCardStyle.keywords}
          className="space-y-3 py-2"
          id="experimental-new-worktree-card-style"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 shrink space-y-0.5">
              <Label>
                {translate(
                  'auto.components.settings.ExperimentalPane.newWorktreeCardStyle.title',
                  'New card style'
                )}
              </Label>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.ExperimentalPane.newWorktreeCardStyle.copy',
                  'Previews updated worktree-card layout and metadata behavior, including hover/context-menu ownership and status presentation.'
                )}
              </p>
            </div>
            <SettingsSwitch
              checked={newWorktreeCardStyleEnabled}
              ariaLabel={translate(
                'auto.components.settings.ExperimentalPane.newWorktreeCardStyle.toggleLabel',
                'Toggle new card style'
              )}
              onChange={() =>
                updateSettings({
                  experimentalNewWorktreeCardStyle: !newWorktreeCardStyleEnabled
                })
              }
            />
          </div>
        </SearchableSetting>
      ) : null}

      <EphemeralVmsExperimentalSetting settings={settings} updateSettings={updateSettings} />

      <OmniSiPreviewsExperimentalSetting settings={settings} updateSettings={updateSettings} />

      <SearchableSetting
        title={translate('decisionsTitlebar.setting.title', 'Decisions badge in the titlebar')}
        description={translate(
          'decisionsTitlebar.setting.description',
          'Shows how many decisions are waiting for you in the titlebar. Clicking it opens Decisions; it never answers anything.'
        )}
        keywords={['decisions', 'badge', 'titlebar', 'review']}
        id="decisions-titlebar-badge"
      >
        <SettingsSwitchRow
          label={translate('decisionsTitlebar.setting.title', 'Decisions badge in the titlebar')}
          description={translate(
            'decisionsTitlebar.setting.description',
            'Shows how many decisions are waiting for you in the titlebar. Clicking it opens Decisions; it never answers anything.'
          )}
          ariaLabel={translate('decisionsTitlebar.setting.toggleLabel', 'Toggle decisions badge')}
          checked={settings.experimentalDecisionsTitlebarBadge === true}
          onChange={() =>
            updateSettings({
              experimentalDecisionsTitlebarBadge:
                settings.experimentalDecisionsTitlebarBadge !== true
            })
          }
        />
      </SearchableSetting>

      {hiddenExperimentalUnlocked ? <HiddenExperimentalGroup /> : null}
    </div>
  )
}
