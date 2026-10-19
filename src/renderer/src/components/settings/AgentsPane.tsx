import { AgentTeamModeSetting } from './AgentTeamModeSetting'
import { DeliverableCheckSetting } from './DeliverableCheckSetting'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Info } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { useDetectedAgents, type AgentDetectionTarget } from '@/hooks/useDetectedAgents'
import { useAppStore } from '@/store'
import { AgentAccountProfilesSetting } from './AgentAccountProfilesSetting'
import { SessionActionPresetsSetting } from './SessionActionPresetsSetting'
import { AgentTemplatesSetting } from './AgentTemplatesSetting'
import { useLaunchContext } from '../sidebar/session-folders/new-conversation/launch-context'
import { InstructionFilesSetting } from './InstructionFilesSetting'
import { LocalOllamaSetting } from './LocalOllamaSetting'
import { AgentAwakeSetting } from './AgentAwakeSetting'
import { AgentCacheTimerSection } from './AgentCacheTimerSection'
import { AgentRuntimeSetting } from './AgentRuntimeSetting'
import { buildCodexSessionSourceHomeControl } from './codex-session-source-home-control'
import {
  getAgentGeneratedTabTitlesDescription,
  getAgentGeneratedTabTitlesTitle
} from './agent-generated-tab-title-copy'
import { getAgentStatusHooksDescription, getAgentStatusHooksTitle } from './agent-status-hooks-copy'
import {
  SettingsSegmentedControl,
  SettingsSubsectionHeader,
  SettingsSwitchRow
} from './SettingsFormControls'
import {
  isTuiAgentEnabled,
  normalizeDisabledTuiAgents
} from '../../../../shared/tui-agent-selection'
import {
  getTuiAgentDefaultArgs,
  getTuiAgentDefaultEnv,
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../../shared/tui-agent-launch-defaults'
import {
  applyAgentPermissionMode,
  resolveAgentPermissionModeSummary,
  type AgentPermissionMode,
  type SelectableAgentPermissionMode
} from '../../../../shared/tui-agent-permissions'
import { getSettingOwnershipSummary } from './setting-ownership'
import { translate } from '@/i18n/i18n'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'
import { getAgentsPaneSearchEntries } from './agents-search'
import {
  buildAgentAvailabilitySettingsUpdate,
  createAgentAvailabilityUpdateQueue
} from './agent-availability-settings'
import { AgentAvailabilityControl, type AgentCatalogRowProps } from './AgentCatalogRow'
import { AgentDefaultSetting } from './AgentDefaultSetting'
import { AgentDetectionCatalog } from './AgentDetectionCatalog'

export {
  buildAgentAvailabilitySettingsUpdate,
  createAgentAvailabilityUpdateQueue,
  getAgentsPaneSearchEntries,
  AgentAvailabilityControl
}

type AgentsPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
  wslSupportedPlatform?: boolean
  wslAvailable?: boolean
  wslDistros?: string[]
  wslCapabilitiesLoading?: boolean
}

const enqueueAgentAvailabilityUpdate = createAgentAvailabilityUpdateQueue()

function getAgentPermissionModeOptions(): {
  value: Exclude<SelectableAgentPermissionMode, 'manual'>
  label: string
  description: string
}[] {
  return [
    {
      value: 'yolo',
      label: translate('auto.components.settings.AgentsPane.agentPermissionsYolo', 'Yolo'),
      description: translate(
        'auto.components.settings.AgentsPane.agentPermissionsYoloDescription',
        'Skip permission prompts and run tools unattended.'
      )
    },
    {
      value: 'plan',
      label: translate('auto.components.settings.AgentsPane.agentPermissionsPlan', 'Plan'),
      description: translate(
        'auto.components.settings.AgentsPane.agentPermissionsPlanDescription',
        'Claude, Grok, and Gemini: plan mode (reads and exploration commands still run). Codex has no plan mode; launches with its defaults.'
      )
    },
    {
      value: 'read-only',
      label: translate('auto.components.settings.AgentsPane.agentPermissionsReadOnly', 'Read-only'),
      description: translate(
        'auto.components.settings.AgentsPane.agentPermissionsReadOnlyDescription',
        'Codex: read-only sandbox; runs permitted commands without approval prompts. Claude, Grok, and Gemini: same as plan (reads and exploration commands still run).'
      )
    },
    {
      value: 'approve',
      label: translate('auto.components.settings.AgentsPane.agentPermissionsApprove', 'Approve'),
      description: translate(
        'auto.components.settings.AgentsPane.agentPermissionsApproveDescription',
        "No permission flags; each vendor's own defaults decide. Ordinary reads may not prompt."
      )
    }
  ]
}

function visibleAgentPermissionMode(
  mode: AgentPermissionMode
): Exclude<SelectableAgentPermissionMode, 'manual'> {
  if (mode === 'mixed') {
    return 'yolo'
  }
  if (mode === 'manual') {
    return 'approve'
  }
  return mode
}

export function AgentPermissionsSetting({
  mode,
  onChange
}: {
  mode: AgentPermissionMode
  onChange: (mode: SelectableAgentPermissionMode) => void
}): React.JSX.Element {
  const visibleMode = visibleAgentPermissionMode(mode)
  return (
    <section className="space-y-3">
      <SettingsSubsectionHeader
        title={
          <span className="flex items-center gap-2">
            {translate('auto.components.settings.AgentsPane.agentPermissions', 'Agent Permissions')}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={translate(
                    'auto.components.settings.AgentsPane.agentPermissionsInfo',
                    'Agent permissions info'
                  )}
                  className="grid size-5 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <Info className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6}>
                {translate(
                  'auto.components.settings.AgentsPane.agentPermissionsTooltip',
                  "Doesn't apply to agents where you've overridden launch arguments."
                )}
              </TooltipContent>
            </Tooltip>
          </span>
        }
        description={translate(
          'auto.components.settings.AgentsPane.agentPermissionsDescription',
          'Choose Yolo, a restricted launch preset, or Approve for vendor CLI permission flags.'
        )}
        action={
          <SettingsSegmentedControl<AgentPermissionMode>
            value={visibleMode}
            onChange={(nextMode) => {
              if (nextMode !== 'mixed' && nextMode !== 'manual') {
                onChange(nextMode)
              }
            }}
            ariaLabel={translate(
              'auto.components.settings.AgentsPane.agentPermissions',
              'Agent Permissions'
            )}
            size="sm"
            options={getAgentPermissionModeOptions().map((option) => ({
              value: option.value,
              label: option.label,
              tooltip: option.description
            }))}
          />
        }
      />
    </section>
  )
}

export function AgentsPane({
  settings,
  updateSettings,
  wslSupportedPlatform,
  wslAvailable,
  wslDistros,
  wslCapabilitiesLoading
}: AgentsPaneProps): React.JSX.Element {
  // Why: a keyed one-shot request; StrictMode's mount/unmount rehearsal must not clear it, so nothing does.
  const editTemplate = useLaunchContext((state) => state.editTemplate)
  // Why: a workspace switch remounts the file pane, so drafts and open editors never carry over.
  const activeWorkspaceKey = useAppStore((state) => state.activeWorkspaceKey)
  useTranslation()
  const activeServerEnvironmentId = settings.activeRuntimeEnvironmentId?.trim() || null
  const agentDetectionTarget = useMemo<AgentDetectionTarget>(
    () =>
      activeServerEnvironmentId
        ? { kind: 'runtime', environmentId: activeServerEnvironmentId }
        : { kind: 'local' },
    [activeServerEnvironmentId]
  )
  const {
    detectedIds: detectedList,
    detectionFailed,
    isRefreshing,
    refresh: refreshTargetAgents
  } = useDetectedAgents(agentDetectionTarget)
  const refreshLocalAgents = useAppStore((state) => state.refreshDetectedAgents)
  const activeServerName = useAppStore((state) =>
    activeServerEnvironmentId
      ? (state.runtimeEnvironments.find(
          (environment) => environment.id === activeServerEnvironmentId
        )?.name ?? null)
      : null
  )
  const detectedIds = useMemo<Set<string> | null>(
    () => (detectedList ? new Set(detectedList) : null),
    [detectedList]
  )
  const catalog = getAgentCatalog()
  const defaultAgent = settings.defaultTuiAgent
  const cmdOverrides = settings.agentCmdOverrides ?? {}
  const agentDefaultArgs = settings.agentDefaultArgs ?? {}
  const agentDefaultEnv = settings.agentDefaultEnv ?? {}
  const disabledAgents = normalizeDisabledTuiAgents(settings.disabledTuiAgents)
  const detectedAgents =
    detectedIds === null ? [] : catalog.filter((agent) => detectedIds.has(agent.id))
  const enabledDetectedAgents = detectedAgents.filter((agent) =>
    isTuiAgentEnabled(agent.id, disabledAgents)
  )
  const undetectedAgents = catalog.filter(
    (agent) => detectedIds !== null && !detectedIds.has(agent.id)
  )

  const setAgentEnabled = (id: TuiAgent, enabled: boolean): void => {
    void enqueueAgentAvailabilityUpdate({
      getSettings: () => useAppStore.getState().settings,
      fallbackSettings: settings,
      updateSettings,
      agentId: id,
      enabled
    })
  }
  const getRowProps = (
    agent: (typeof catalog)[number],
    isDetected: boolean
  ): AgentCatalogRowProps => ({
    agentId: agent.id,
    label: agent.label,
    homepageUrl: agent.homepageUrl,
    defaultCmd: agent.cmd,
    defaultArgs: getTuiAgentDefaultArgs(agent.id),
    defaultEnv: getTuiAgentDefaultEnv(agent.id),
    isDetected,
    isEnabled: isTuiAgentEnabled(agent.id, disabledAgents),
    isDefault: isDetected && defaultAgent === agent.id,
    cmdOverride: isDetected ? cmdOverrides[agent.id] : undefined,
    argsOverride: resolveTuiAgentLaunchArgs(agent.id, agentDefaultArgs),
    envOverride: resolveTuiAgentLaunchEnv(agent.id, agentDefaultEnv),
    onSetDefault: isDetected ? () => updateSettings({ defaultTuiAgent: agent.id }) : () => {},
    onSetEnabled: (enabled) => setAgentEnabled(agent.id, enabled),
    onSaveOverride: isDetected
      ? (value) => {
          const next = { ...cmdOverrides }
          if (value) {
            next[agent.id] = value
          } else {
            delete next[agent.id]
          }
          updateSettings({ agentCmdOverrides: next })
        }
      : () => {},
    onSaveArgs: (value) =>
      updateSettings({ agentDefaultArgs: { ...agentDefaultArgs, [agent.id]: value } }),
    onSaveEnv: (value) =>
      updateSettings({ agentDefaultEnv: { ...agentDefaultEnv, [agent.id]: value } }),
    sessionSourceHome:
      isDetected && agent.id === 'codex'
        ? buildCodexSessionSourceHomeControl(settings, updateSettings)
        : undefined
  })

  return (
    <div className="space-y-8">
      <AgentDefaultSetting
        defaultAgent={defaultAgent}
        detectedIds={detectedIds}
        enabledDetectedAgents={enabledDetectedAgents}
        catalog={catalog}
        description={getSettingOwnershipSummary('agentLaunchDefaults').description}
        onSetDefault={(agent) => updateSettings({ defaultTuiAgent: agent })}
      />
      <AgentTeamModeSetting settings={settings} updateSettings={updateSettings} />
      <AgentRuntimeSetting
        settings={settings}
        updateSettings={updateSettings}
        refresh={refreshLocalAgents}
        wslSupportedPlatform={wslSupportedPlatform}
        wslAvailable={wslAvailable}
        wslDistros={wslDistros}
        wslCapabilitiesLoading={wslCapabilitiesLoading}
      />
      <AgentStatusHooksSetting settings={settings} updateSettings={updateSettings} />
      <AgentGeneratedTabTitlesSetting settings={settings} updateSettings={updateSettings} />
      <DeliverableCheckSetting settings={settings} updateSettings={updateSettings} />
      {!isPairedWebClientWindow() ? (
        <AgentAwakeSetting settings={settings} updateSettings={updateSettings} />
      ) : null}
      <AgentCacheTimerSection settings={settings} updateSettings={updateSettings} />
      <AgentAccountProfilesSetting settings={settings} updateSettings={updateSettings} />
      <AgentTemplatesSetting
        key={editTemplate?.nonce ?? 0}
        settings={settings}
        initialTemplateId={editTemplate?.id}
      />
      {!isPairedWebClientWindow() ? (
        <InstructionFilesSetting key={activeWorkspaceKey ?? 'none'} />
      ) : null}
      {!isPairedWebClientWindow() ? <LocalOllamaSetting settings={settings} /> : null}
      <SessionActionPresetsSetting settings={settings} updateSettings={updateSettings} />
      <AgentPermissionsSetting
        mode={resolveAgentPermissionModeSummary({ agentDefaultArgs, agentDefaultEnv })}
        onChange={(mode) =>
          updateSettings(applyAgentPermissionMode({ mode, agentDefaultArgs, agentDefaultEnv }))
        }
      />
      <AgentDetectionCatalog
        detectedAgents={detectedAgents}
        undetectedAgents={undetectedAgents}
        detectionPending={detectedIds === null}
        detectionFailed={detectionFailed}
        isRefreshing={isRefreshing}
        activeServerEnvironmentId={activeServerEnvironmentId}
        activeServerName={activeServerName}
        onRefresh={() => void refreshTargetAgents()}
        getRowProps={getRowProps}
      />
    </div>
  )
}

export function AgentStatusHooksSetting({ settings, updateSettings }: AgentsPaneProps) {
  const enabled = settings.agentStatusHooksEnabled !== false
  return (
    <section className="space-y-3">
      <SettingsSwitchRow
        label={getAgentStatusHooksTitle()}
        description={getAgentStatusHooksDescription()}
        checked={enabled}
        onChange={() => updateSettings({ agentStatusHooksEnabled: !enabled })}
        ariaLabel={getAgentStatusHooksTitle()}
      />
    </section>
  )
}

export function AgentGeneratedTabTitlesSetting({ settings, updateSettings }: AgentsPaneProps) {
  const enabled = settings.tabAutoGenerateTitle === true
  return (
    <section className="space-y-3">
      <SettingsSwitchRow
        label={getAgentGeneratedTabTitlesTitle()}
        description={getAgentGeneratedTabTitlesDescription()}
        checked={enabled}
        onChange={() => updateSettings({ tabAutoGenerateTitle: !enabled })}
        ariaLabel={getAgentGeneratedTabTitlesTitle()}
      />
    </section>
  )
}
