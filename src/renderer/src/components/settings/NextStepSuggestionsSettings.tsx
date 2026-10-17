import { useRef, useState } from 'react'
import type React from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { briefOneShotAgent } from '../../../../shared/assisted-brief-actors'
import { listCommitMessageAgentCapabilities } from '../../../../shared/commit-message-agent-spec'
import type { NextStepAdPauses } from '../../../../shared/next-step-ad-pauses'
import {
  NEXT_STEP_KEEP_GOING_MAX_ROUNDS,
  NEXT_STEP_KEEP_GOING_MIN_ROUNDS,
  type NextStepKeepGoingMode
} from '../../../../shared/next-step-keep-going'
import {
  keepGoingDefaultRounds,
  nextStepJevSettings,
  normalizeNextStepSuggestionSettings,
  type NextStepJevSettings,
  type NextStepSuggestionSettings
} from '../../../../shared/next-step-suggestion-settings'
import { normalizeSourceControlAiSettings } from '../../../../shared/source-control-ai'
import { AgentIcon } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Switch } from '../ui/switch'
import { keepGoingModeLabel } from '../next-steps/next-steps-keep-going-mode'
import { SearchableSetting } from './SearchableSetting'
import { useAppStore } from '../../store'

const OWN_AGENT = '__conversation_agent__'
const DEFAULT_MODEL = '__default_model__'
const KEEP_GOING_ROUNDS = Array.from(
  { length: NEXT_STEP_KEEP_GOING_MAX_ROUNDS - NEXT_STEP_KEEP_GOING_MIN_ROUNDS + 1 },
  (_, at) => NEXT_STEP_KEEP_GOING_MIN_ROUNDS + at
)

/** The CLIs that can write suggestions: the same one-shot runners the Source Control AI uses. */
function suggesterCapabilities() {
  return listCommitMessageAgentCapabilities().filter(
    (capability) => briefOneShotAgent(capability.id) === capability.id
  )
}

/** Models for a CLI: what Source Control AI discovered on this machine, else its known list. */
function modelsFor(settings: GlobalSettings, agent: TuiAgent) {
  const discovered = normalizeSourceControlAiSettings(
    settings.sourceControlAi,
    settings.commitMessageAi
  ).discoveredModelsByAgent?.[agent]
  if (discovered?.length) {
    return discovered
  }
  return suggesterCapabilities().find((capability) => capability.id === agent)?.models ?? []
}

function jevHint(): string {
  return translate(
    'nextStepSettings.jevHint',
    'JEV, a fast judge, orders the steps, marks a step risky when it clearly is, and reads how done the work is. It never lowers a risk or runs anything; without a TypeSafe key nothing changes.'
  )
}

export function NextStepSuggestionsSettings({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}): React.JSX.Element {
  const config = normalizeNextStepSuggestionSettings(settings.nextStepSuggestions)
  const [saveError, setSaveError] = useState<string | null>(null)
  const writes = useRef(0)
  const write = (patch: Partial<NextStepSuggestionSettings>): void => {
    const latest = normalizeNextStepSuggestionSettings(
      (useAppStore.getState().settings ?? settings).nextStepSuggestions
    )
    const next = { ...latest, ...patch }
    // Why a generation: a slow refusal of an older write must not paint over a later success.
    const generation = ++writes.current
    setSaveError(null)
    Promise.resolve()
      .then(() =>
        updateSettings({
          nextStepSuggestions: normalizeNextStepSuggestionSettings({
            enabled: next.enabled,
            ...(next.agent ? { agent: next.agent } : {}),
            ...(next.model ? { model: next.model } : {}),
            ...(next.keepGoingMaxRounds ? { keepGoingMaxRounds: next.keepGoingMaxRounds } : {}),
            ...(next.keepGoingDefaultMode
              ? { keepGoingDefaultMode: next.keepGoingDefaultMode }
              : {}),
            ...(next.keepGoingPushPrompt ? { keepGoingPushPrompt: next.keepGoingPushPrompt } : {}),
            ...(next.jev ? { jev: next.jev } : {}),
            // Absent = allowed, so only ask-first is written.
            ...(next.adPauses === 'ask-first' ? { adPauses: next.adPauses } : {})
          })
        })
      )
      .then(
        () => {
          if (generation === writes.current) {
            setSaveError(null)
          }
        },
        (failure: unknown) => {
          if (generation === writes.current) {
            setSaveError(failure instanceof Error ? failure.message : String(failure))
          }
        }
      )
  }
  const title = translate('nextStepSettings.title', 'Suggested next steps')
  const description = translate(
    'nextStepSettings.description',
    'After each Claude or Codex turn, one read-only model call proposes what to do next. Nothing runs until you click.'
  )
  const models = config.agent ? modelsFor(settings, config.agent) : []
  const jev = nextStepJevSettings(config)
  const jevSwitches: { key: keyof NextStepJevSettings; label: string }[] = [
    { key: 'rank', label: translate('nextStepSettings.jevRank', 'Rank') },
    { key: 'risk', label: translate('nextStepSettings.jevRisk', 'Risk check') },
    { key: 'doneness', label: translate('nextStepSettings.jevDoneness', 'How done') }
  ]
  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={[
        'next steps',
        'suggestions',
        'suggest',
        'ai',
        'agent',
        'model',
        'keep going',
        'ad pauses'
      ]}
      className="space-y-3 border-t border-border/40 pt-4"
      id="next-step-suggestions-settings"
    >
      <div className="space-y-0.5">
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="flex items-center justify-between gap-4 py-1">
        <Label htmlFor="next-step-suggestions-enabled">
          {translate('nextStepSettings.enabled', 'Suggest next steps after each AI turn')}
        </Label>
        <Switch
          id="next-step-suggestions-enabled"
          checked={config.enabled}
          onCheckedChange={(checked) => write({ enabled: checked })}
        />
      </div>
      <div className="grid grid-cols-[92px_minmax(0,1fr)] items-center gap-3">
        <Label className="text-xs">{translate('nextStepSettings.agent', 'Suggester')}</Label>
        <Select
          value={config.agent ?? OWN_AGENT}
          onValueChange={(value) =>
            write(
              value === OWN_AGENT
                ? { agent: undefined, model: undefined }
                : { agent: value as TuiAgent, model: undefined }
            )
          }
        >
          <SelectTrigger
            size="sm"
            className="h-8 w-full text-xs"
            aria-label={translate('nextStepSettings.agent', 'Suggester')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="start">
            <SelectItem value={OWN_AGENT}>
              {translate('nextStepSettings.ownAgent', 'The conversation’s own agent')}
            </SelectItem>
            {suggesterCapabilities().map((capability) => (
              <SelectItem key={capability.id} value={capability.id}>
                <span className="flex items-center gap-2">
                  <AgentIcon agent={capability.id} size={14} />
                  {capability.label}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {config.agent && models.length ? (
          <>
            <Label className="text-xs">{translate('nextStepSettings.model', 'Model')}</Label>
            <Select
              value={config.model ?? DEFAULT_MODEL}
              onValueChange={(value) =>
                write({ model: value === DEFAULT_MODEL ? undefined : value })
              }
            >
              <SelectTrigger
                size="sm"
                className="h-8 w-full text-xs"
                aria-label={translate('nextStepSettings.model', 'Model')}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="start">
                <SelectItem value={DEFAULT_MODEL}>
                  {translate('nextStepSettings.defaultModel', 'Default model')}
                </SelectItem>
                {models.map((model) => (
                  <SelectItem key={model.id} value={model.id}>
                    {model.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        ) : null}
        <Label className="text-xs">
          {translate('nextStepSettings.keepGoingRounds', 'Keep going')}
        </Label>
        <Select
          value={String(keepGoingDefaultRounds(config))}
          onValueChange={(value) => write({ keepGoingMaxRounds: Number(value) })}
        >
          <SelectTrigger
            size="sm"
            className="h-8 w-full text-xs"
            aria-label={translate(
              'nextStepSettings.keepGoingRoundsLabel',
              'Keep going: default rounds'
            )}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="start">
            {KEEP_GOING_ROUNDS.map((rounds) => (
              <SelectItem key={rounds} value={String(rounds)}>
                {translate('nextStepSettings.keepGoingRoundsChoice', '{{n}} rounds by default', {
                  n: rounds
                })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Label className="text-xs">
          {translate('nextStepSettings.keepGoingMode', 'Keep going sends')}
        </Label>
        <Select
          value={config.keepGoingDefaultMode ?? 'next-step'}
          onValueChange={(value) => write({ keepGoingDefaultMode: value as NextStepKeepGoingMode })}
        >
          <SelectTrigger
            size="sm"
            className="h-8 w-full text-xs"
            aria-label={translate(
              'nextStepSettings.keepGoingModeLabel',
              'Keep going: default mode'
            )}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="start">
            {(['next-step', 'push-for-better'] as const).map((mode) => (
              <SelectItem key={mode} value={mode}>
                {keepGoingModeLabel(mode)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Label className="text-xs">{translate('nextStepSettings.adPauses', 'Ad pauses')}</Label>
        <Select
          value={config.adPauses ?? 'allowed'}
          onValueChange={(value) => write({ adPauses: value as NextStepAdPauses })}
        >
          <SelectTrigger
            size="sm"
            className="h-8 w-full text-xs"
            aria-label={translate(
              'nextStepSettings.adPausesLabel',
              'Ad pauses: allowed or ask first'
            )}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" align="start">
            <SelectItem value="allowed">
              {translate('nextStepSettings.adPausesAllowed', 'Allowed (default)')}
            </SelectItem>
            <SelectItem value="ask-first">
              {translate('nextStepSettings.adPausesAskFirst', 'Ask me first')}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      <p className="text-xs text-muted-foreground">
        {translate(
          'nextStepSettings.adPausesHint',
          'Keep going and other sessions may pause ads and ad sets without asking; each pause is recorded. Whole campaigns and OmniRogue Enterprise ads are never paused, and budget, bid and spend changes always need you. A session’s own choice wins.'
        )}
      </p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1">
        <span className="text-xs">{translate('nextStepSettings.jev', 'JEV')}</span>
        {jevSwitches.map(({ key, label }) => (
          <span key={key} className="flex items-center gap-1.5">
            <Switch
              id={`next-step-jev-${key}`}
              checked={jev[key]}
              onCheckedChange={(checked) => write({ jev: { ...jev, [key]: checked } })}
            />
            <Label htmlFor={`next-step-jev-${key}`} className="text-xs font-normal">
              {label}
            </Label>
          </span>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{jevHint()}</p>
      {saveError ? (
        <p role="alert" className="text-xs text-destructive">
          {translate('nextStepSettings.saveFailed', 'This setting was not saved: {{reason}}', {
            reason: saveError
          })}
        </p>
      ) : null}
    </SearchableSetting>
  )
}
