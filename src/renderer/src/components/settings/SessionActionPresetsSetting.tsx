import { useState } from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  DEFAULT_SESSION_ACTION_TEMPLATES,
  SESSION_ACTION_PRESET_IDS,
  SESSION_ACTION_PRESET_LABELS,
  SESSION_ACTION_VARIABLE_INFO,
  SESSION_ACTION_VARIABLES,
  isSessionActionPresetId,
  type SessionActionPresetId
} from '../../../../shared/session-action-presets'
import { ALL_TUI_AGENTS, TUI_AGENT_DISPLAY_NAMES } from '../../../../shared/tui-agent-display-names'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import { SettingsSubsectionHeader } from './SettingsFormControls'

type SessionActionPresetsSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}

const AGENT_DEFAULT = '__agent-default__'

/**
 * Global action presets for chained sessions: the template each node type launches
 * with and the agent it defaults to. Templates are written for any kind of work;
 * a workspace can override one from the queue dialog.
 */
export function SessionActionPresetsSetting({
  settings,
  updateSettings
}: SessionActionPresetsSettingProps): React.JSX.Element {
  const [presetId, setPresetId] = useState<SessionActionPresetId>('improve')
  const presets = settings.sessionActionPresets ?? {}
  const recipe = presets[presetId]
  const template = recipe?.template ?? DEFAULT_SESSION_ACTION_TEMPLATES[presetId]
  const isDefault = !recipe?.template
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? template
  const dirty = draft !== null && draft !== template

  const save = (): void => {
    if (draft === null) {
      return
    }
    const next =
      draft.trim() && draft !== DEFAULT_SESSION_ACTION_TEMPLATES[presetId] ? draft : undefined
    void updateSettings({
      sessionActionPresets: {
        ...presets,
        [presetId]: { ...recipe, ...(next ? { template: next } : {}) }
      }
    })
    if (!next) {
      const { template: _dropped, ...rest } = recipe ?? {}
      void updateSettings({ sessionActionPresets: { ...presets, [presetId]: rest } })
    }
    setDraft(null)
  }

  const reset = (): void => {
    const { template: _dropped, ...rest } = recipe ?? {}
    void updateSettings({ sessionActionPresets: { ...presets, [presetId]: rest } })
    setDraft(null)
  }

  const setDefaultAgent = (value: string): void => {
    const { agent: _dropped, ...actor } = recipe?.actor ?? {}
    void updateSettings({
      sessionActionPresets: {
        ...presets,
        [presetId]: {
          ...recipe,
          actor: isTuiAgent(value) ? { ...actor, agent: value } : actor
        }
      }
    })
  }

  return (
    <section className="space-y-4">
      <SettingsSubsectionHeader
        title={translate(
          'components.settings.sessionActionPresets.title',
          'Session action presets'
        )}
        description={translate(
          'components.settings.sessionActionPresets.description',
          'The instruction template a queued session launches with for each action. Templates work on any folder of files, not only code; {{objective}} is what you type, {{input}} and {{inputFiles}} come from the previous session, {{outputDir}} is where the step writes.'
        )}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="session-action-preset">
            {translate('components.settings.sessionActionPresets.action', 'Action')}
          </Label>
          <Select
            value={presetId}
            onValueChange={(value) => {
              if (isSessionActionPresetId(value)) {
                setPresetId(value)
                setDraft(null)
              }
            }}
          >
            <SelectTrigger id="session-action-preset" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SESSION_ACTION_PRESET_IDS.map((id) => (
                <SelectItem key={id} value={id}>
                  {SESSION_ACTION_PRESET_LABELS[id]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="session-action-preset-agent">
            {translate('components.settings.sessionActionPresets.defaultAgent', 'Default agent')}
          </Label>
          <Select value={recipe?.actor?.agent ?? AGENT_DEFAULT} onValueChange={setDefaultAgent}>
            <SelectTrigger id="session-action-preset-agent" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={AGENT_DEFAULT}>
                {translate(
                  'components.settings.sessionActionPresets.keepSourceAgent',
                  'Same as the previous session'
                )}
              </SelectItem>
              {ALL_TUI_AGENTS.map((agent) => (
                <SelectItem key={agent} value={agent}>
                  {TUI_AGENT_DISPLAY_NAMES[agent]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="session-action-preset-template">
          {translate('components.settings.sessionActionPresets.template', 'Template')}
          {isDefault ? (
            <span className="ml-2 text-[11px] font-normal text-muted-foreground">
              {translate('components.settings.sessionActionPresets.builtIn', 'built-in')}
            </span>
          ) : null}
        </Label>
        <Textarea
          id="session-action-preset-template"
          value={shown}
          rows={10}
          className="font-mono text-xs"
          onChange={(event) => setDraft(event.target.value)}
        />
        <p className="text-[11px] text-muted-foreground">
          {SESSION_ACTION_VARIABLES.map((variable) => (
            <span
              key={variable}
              className="mr-3 inline-block"
              title={SESSION_ACTION_VARIABLE_INFO[variable].description}
            >
              <code>{`{{${variable}}}`}</code>
            </span>
          ))}
        </p>
        <div className="flex gap-2">
          <Button type="button" size="sm" disabled={!dirty} onClick={save}>
            {translate('components.settings.sessionActionPresets.save', 'Save template')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={isDefault && draft === null}
            onClick={reset}
          >
            {translate('components.settings.sessionActionPresets.reset', 'Reset to built-in')}
          </Button>
        </div>
      </div>
    </section>
  )
}
