import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  AGENT_ACCOUNT_CONFIG_DIR_ENV,
  isAccountProfileOwnerAgent,
  type AgentAccountProfile
} from '../../../../shared/agent-account-profiles'
import { ALL_TUI_AGENTS, TUI_AGENT_DISPLAY_NAMES } from '../../../../shared/tui-agent-display-names'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import { SettingsSubsectionHeader } from './SettingsFormControls'

type AgentAccountProfilesSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}

// Why: Agent Teams reads Claude's profiles, so listing it here would split one sign-in in two.
const PROFILE_AGENTS = ALL_TUI_AGENTS.filter((agent) => isAccountProfileOwnerAgent(agent))

// Why: the directory becomes a raw environment value; a CLI never expands `~` there,
// so only an absolute path (POSIX, drive-letter or UNC) can name a real directory.
const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/

export function isAbsoluteConfigDir(value: string): boolean {
  return ABSOLUTE_PATH.test(value.trim())
}

/**
 * Named account profiles beside the per-agent launch env: a label and the config
 * directory (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`) a launch starts under. Only paths are
 * kept; sign-in stays with the CLI in that directory.
 */
export function AgentAccountProfilesSetting({
  settings,
  updateSettings
}: AgentAccountProfilesSettingProps): React.JSX.Element {
  const profiles = settings.agentAccountProfiles ?? []
  const [label, setLabel] = useState('')
  const [agent, setAgent] = useState<TuiAgent>(PROFILE_AGENTS[0] ?? 'claude')
  const [configDir, setConfigDir] = useState('')
  const configDirValid = isAbsoluteConfigDir(configDir)
  const canAdd = label.trim().length > 0 && configDirValid

  const addProfile = (): void => {
    if (!canAdd) {
      return
    }
    const profile: AgentAccountProfile = {
      id: crypto.randomUUID(),
      label: label.trim(),
      agent,
      configDir: configDir.trim()
    }
    void updateSettings({ agentAccountProfiles: [...profiles, profile] })
    setLabel('')
    setConfigDir('')
  }

  const removeProfile = (id: string): void => {
    void updateSettings({
      agentAccountProfiles: profiles.filter((profile) => profile.id !== id)
    })
  }

  return (
    <section className="space-y-4">
      <SettingsSubsectionHeader
        title={translate('components.settings.agentAccountProfiles.title', 'Account profiles')}
        description={translate(
          'components.settings.agentAccountProfiles.description',
          'Name a config directory so a queued or continued session can start under that sign-in. OmniConsole stores the path only; sign in with the CLI in that directory yourself.'
        )}
      />
      {profiles.length > 0 ? (
        <ul className="space-y-2">
          {profiles.map((profile) => (
            <li
              key={profile.id}
              className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{profile.label}</div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {TUI_AGENT_DISPLAY_NAMES[profile.agent]} ·{' '}
                  {AGENT_ACCOUNT_CONFIG_DIR_ENV[profile.agent]}=
                  <span className="font-mono">{profile.configDir}</span>
                </div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={translate(
                  'components.settings.agentAccountProfiles.remove',
                  'Remove profile {{label}}',
                  { label: profile.label }
                )}
                onClick={() => removeProfile(profile.id)}
              >
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">
          {translate(
            'components.settings.agentAccountProfiles.empty',
            'No account profiles yet. Managed accounts from the status bar are always offered.'
          )}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-[1fr_140px_1fr_auto] sm:items-end">
        <div className="space-y-1.5">
          <Label htmlFor="agent-account-profile-label">
            {translate('components.settings.agentAccountProfiles.label', 'Label')}
          </Label>
          <Input
            id="agent-account-profile-label"
            value={label}
            placeholder={translate(
              'components.settings.agentAccountProfiles.labelPlaceholder',
              'Second Claude account'
            )}
            onChange={(event) => setLabel(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="agent-account-profile-agent">
            {translate('components.settings.agentAccountProfiles.agent', 'Agent')}
          </Label>
          <Select value={agent} onValueChange={(next) => setAgent(next as TuiAgent)}>
            <SelectTrigger id="agent-account-profile-agent" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROFILE_AGENTS.map((candidate) => (
                <SelectItem key={candidate} value={candidate}>
                  {TUI_AGENT_DISPLAY_NAMES[candidate]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="agent-account-profile-dir">
            {translate('components.settings.agentAccountProfiles.configDir', 'Config directory')}
          </Label>
          <Input
            id="agent-account-profile-dir"
            value={configDir}
            placeholder={
              agent === 'codex'
                ? translate(
                    'components.settings.agentAccountProfiles.codexDirPlaceholder',
                    '/Users/me/.codex-second'
                  )
                : translate(
                    'components.settings.agentAccountProfiles.claudeDirPlaceholder',
                    '/Users/me/.claude-accounts/second'
                  )
            }
            onChange={(event) => setConfigDir(event.target.value)}
          />
          {configDir.trim() && !configDirValid ? (
            <p className="text-[11px] text-destructive">
              {translate(
                'components.settings.agentAccountProfiles.absolutePath',
                'Use an absolute path; the CLI does not expand ~ in its environment.'
              )}
            </p>
          ) : null}
        </div>
        <Button type="button" variant="outline" disabled={!canAdd} onClick={addProfile}>
          {translate('components.settings.agentAccountProfiles.add', 'Add profile')}
        </Button>
      </div>
    </section>
  )
}
