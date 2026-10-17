import {
  useWorkAgentCapabilities,
  type WorkAgentCapabilityMode
} from '@/hooks/useWorkAgentCapabilities'
import { ModelDot } from '@/components/ModelDot'
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
import { ALL_TUI_AGENTS, TUI_AGENT_DISPLAY_NAMES } from '../../../../shared/tui-agent-display-names'
import type { BuildReviewAgentChoice } from '../../../../shared/build-review-pipeline'
import type { CatalogModel } from '../../../../shared/agent-session-option-catalog'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  BUILD_REVIEW_AGENT_DEFAULT,
  effortChoicesFor,
  modelChoicesFor,
  type BuildReviewChoiceOption
} from '../../../../shared/build-review-model-options'
import { useBuildReviewAgentModels } from './use-build-review-agent-models'
import { BuildReviewSetupRow } from './BuildReviewSetupRow'

const NO_CHOICES: BuildReviewChoiceOption[] = []
const NO_MODELS: readonly CatalogModel[] = []

function ChoiceSelect({
  id,
  value,
  choices,
  placeholder,
  onChange,
  preserveUnknown = false,
  disableUnknown = false,
  placeholderUnavailable = false,
  unavailable = NO_CHOICES
}: {
  preserveUnknown?: boolean
  disableUnknown?: boolean
  id: string
  value: string | undefined
  choices: BuildReviewChoiceOption[]
  placeholder: string
  onChange: (value: string | undefined) => void
  /** "Agent default" would start a spent model: shown, not selectable. */
  placeholderUnavailable?: boolean
  /** Choices a spent usage window rules out: shown so the person sees why, never selectable. */
  unavailable?: BuildReviewChoiceOption[]
}) {
  // Why: a value chosen before the host probe answered (or typed on an older
  // build) must stay visible and selectable instead of silently blanking.
  const items =
    preserveUnknown && value && !choices.some((choice) => choice.value === value)
      ? [{ value, label: value }, ...choices]
      : choices
  return (
    <Select
      value={items.some((item) => item.value === value) ? value : BUILD_REVIEW_AGENT_DEFAULT}
      onValueChange={(next) => onChange(next === BUILD_REVIEW_AGENT_DEFAULT ? undefined : next)}
    >
      <SelectTrigger id={id} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={BUILD_REVIEW_AGENT_DEFAULT} disabled={placeholderUnavailable}>
          {placeholderUnavailable
            ? translate('buildReview.model.defaultSpent', '{{label}} (out of usage)', {
                label: placeholder
              })
            : placeholder}
        </SelectItem>
        {items.map((choice) => (
          <SelectItem
            key={choice.value}
            value={choice.value}
            title={choice.description}
            disabled={disableUnknown && !choices.some((item) => item.value === choice.value)}
          >
            {choice.label}
          </SelectItem>
        ))}
        {unavailable
          .filter((choice) => !items.some((item) => item.value === choice.value))
          .map((choice) => (
            <SelectItem key={`spent:${choice.value}`} value={`spent:${choice.value}`} disabled>
              {translate('buildReview.model.spent', '{{label}} (out of usage)', {
                label: choice.label
              })}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  )
}

export type CatalogModelEffortFieldsProps = {
  usableOnly?: boolean
  preserveUnavailable?: boolean
  role: string
  agent: string
  models: CatalogModel[]
  /** Models a spent per-model usage window rules out; listed as unavailable. */
  spentModels?: readonly CatalogModel[]
  /** The agent's own default is spent, so "Agent default" is not offered. */
  defaultModelSpent?: boolean
  model: string | undefined
  effort: string | undefined
  onChange: (choice: { model?: string; effort?: string }) => void
  /** Placeholder for "no explicit choice"; surfaces name it after their own default. */
  defaultLabel?: string
  modelDefaultLabel?: string
  effortDefaultLabel?: string
}

/** Resolves models on the workspace's host before rendering the shared controls. */
export function BuildReviewModelEffortFields({
  agent,
  worktree,
  usableOnly = true,
  capabilityMode = 'workspace-launch',
  taskId,
  ...props
}: Omit<CatalogModelEffortFieldsProps, 'models' | 'preserveUnavailable'> & {
  capabilityMode?: WorkAgentCapabilityMode
  taskId?: string
  /** Runtime workspace selector; decides which host's CLIs are asked for their models. */
  worktree: string
}) {
  const discovered = useBuildReviewAgentModels(agent, worktree, !usableOnly)
  const availability = useWorkAgentCapabilities(
    worktree.startsWith('id:') ? worktree.slice(3) : worktree,
    taskId,
    capabilityMode
  )
  const usable = usableOnly ? availability.usable.find((entry) => entry.id === agent) : undefined
  const models = usableOnly ? (usable?.models ?? []) : discovered
  return (
    <CatalogModelEffortFields
      {...props}
      agent={agent}
      models={models}
      spentModels={usable?.unavailableModels}
      defaultModelSpent={usable?.defaultModelUnavailable === true}
      usableOnly={usableOnly}
      preserveUnavailable={capabilityMode === 'task-continuation'}
    />
  )
}

/** Renders the supplied host catalog without probing the current workspace. */
export function CatalogModelEffortFields({
  role,
  agent,
  models,
  model,
  effort,
  onChange,
  defaultLabel,
  modelDefaultLabel,
  effortDefaultLabel,
  usableOnly = true,
  preserveUnavailable = false,
  spentModels = NO_MODELS,
  defaultModelSpent = false
}: CatalogModelEffortFieldsProps) {
  const modelChoices = modelChoicesFor(models)
  const choicesForEffort = (modelId: string | undefined) =>
    usableOnly && (!models.length || (modelId && !models.some((entry) => entry.id === modelId)))
      ? []
      : effortChoicesFor(agent, models, modelId)
  const effortChoices = choicesForEffort(model)
  const effectiveModel = model ?? (models.find((entry) => entry.isDefault) ?? models[0])?.id
  const agentDefault =
    defaultLabel ??
    translate('auto.components.build-review.BuildReviewAgentFields.agentDefault', 'Agent default')
  const setModel = (nextModel: string | undefined) => {
    const nextEfforts = choicesForEffort(nextModel)
    const effortStillValid = effort
      ? nextEfforts.some((candidate) => candidate.value === effort)
      : false
    onChange({
      ...(nextModel ? { model: nextModel } : {}),
      ...(effortStillValid && effort ? { effort } : {})
    })
  }
  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="space-y-2">
        <Label htmlFor={`${role}-model`}>
          {translate('auto.components.build-review.BuildReviewAgentFields.model', 'Model')}
        </Label>
        {modelChoices.length > 0 || (preserveUnavailable && model) ? (
          <ChoiceSelect
            preserveUnknown={!usableOnly || preserveUnavailable}
            disableUnknown={usableOnly}
            id={`${role}-model`}
            value={model}
            choices={modelChoices}
            placeholder={modelDefaultLabel ?? agentDefault}
            placeholderUnavailable={defaultModelSpent}
            unavailable={modelChoicesFor(spentModels)}
            onChange={setModel}
          />
        ) : usableOnly ? (
          <p className="text-xs text-muted-foreground">
            {translate('conversations.modelUnavailable', 'No verified models available.')}
          </p>
        ) : (
          // Advanced settings may accept an explicit model id.
          <Input
            id={`${role}-model`}
            value={model ?? ''}
            placeholder={modelDefaultLabel ?? agentDefault}
            onChange={(e) =>
              onChange({
                ...(e.target.value ? { model: e.target.value } : {}),
                ...(effort ? { effort } : {})
              })
            }
          />
        )}
      </div>
      {!usableOnly || effortChoices.length > 0 || (preserveUnavailable && effort) ? (
        <div className="space-y-2">
          <Label htmlFor={`${role}-effort`}>
            {translate('auto.components.build-review.BuildReviewAgentFields.effort', 'Effort')}
          </Label>
          {effortChoices.length > 0 || (preserveUnavailable && effort) ? (
            <ChoiceSelect
              preserveUnknown={!usableOnly || preserveUnavailable}
              disableUnknown={usableOnly}
              id={`${role}-effort`}
              value={effort}
              choices={effortChoices}
              placeholder={effortDefaultLabel ?? agentDefault}
              onChange={(nextEffort) =>
                onChange({
                  ...(effectiveModel ? { model: effectiveModel } : {}),
                  ...(nextEffort ? { effort: nextEffort } : {})
                })
              }
            />
          ) : (
            <Input
              id={`${role}-effort`}
              value={effort ?? ''}
              placeholder={effortDefaultLabel ?? agentDefault}
              disabled={modelChoices.length > 0}
              onChange={(e) =>
                onChange({
                  ...(model ? { model } : {}),
                  ...(e.target.value ? { effort: e.target.value } : {})
                })
              }
            />
          )}
        </div>
      ) : null}
    </div>
  )
}

export function BuildReviewAgentFields({
  role,
  label,
  worktree,
  choice,
  onChange,
  agents = ALL_TUI_AGENTS,
  helpText,
  defaultLabel,
  usableOnly = true,
  capabilityMode = 'workspace-launch',
  appearance = 'fieldset'
}: {
  usableOnly?: boolean
  capabilityMode?: WorkAgentCapabilityMode
  role: string
  label: string
  /** Runtime worktree selector; decides which host's CLIs are asked for their models. */
  worktree: string
  choice: BuildReviewAgentChoice
  onChange: (choice: BuildReviewAgentChoice) => void
  agents?: readonly TuiAgent[]
  /** Replaces the fields' help line; null leaves it out where the surface explains itself. */
  helpText?: string | null
  defaultLabel?: string
  /** `row`: the Build + Review setup's quiet label column instead of a framed fieldset. */
  appearance?: 'fieldset' | 'row'
}) {
  const availability = useWorkAgentCapabilities(
    worktree.startsWith('id:') ? worktree.slice(3) : worktree,
    undefined,
    capabilityMode
  )
  const usableAgents = usableOnly
    ? agents.filter((agent) => availability.usable.some((entry) => entry.id === agent))
    : agents
  // Why: the setup keeps an agent whose usage reading is old selectable while a real reading
  // is fetched; say so quietly instead of hiding it.
  const usageUnchecked = availability.usable.some(
    (entry) => entry.id === choice.agent && entry.usageUnchecked
  )
  const fields = (
    <>
      {helpText !== null && (
        <p className="text-xs text-muted-foreground">
          {helpText ??
            translate(
              'buildReview.agentHelp',
              'Agent chooses the coding tool; Model chooses its AI; Effort controls reasoning depth. Agent default uses the tool’s configured setting.'
            )}
        </p>
      )}
      <div className="space-y-2">
        <Label htmlFor={`${role}-agent`}>
          {translate('auto.components.build-review.BuildReviewAgentFields.agent', 'Agent')}
        </Label>
        {/* Why: model and effort ids belong to the CLI that was picked; carrying
            them across agents would launch the next one with a foreign flag. */}
        {/* Radix reports '' when the value leaves its options (a host answering late); that is
            not a person's choice and must not pin the seat to no agent. */}
        <Select value={choice.agent} onValueChange={(agent) => agent && onChange({ agent })}>
          <SelectTrigger id={`${role}-agent`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {usableAgents.map((agent) => (
              <SelectItem key={agent} value={agent}>
                <span className="flex items-center gap-1.5">
                  <ModelDot agent={agent} />
                  {TUI_AGENT_DISPLAY_NAMES[agent]}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {usageUnchecked && (
          <p className="text-xs text-muted-foreground" data-build-review-usage="unchecked">
            {translate('buildReview.usageUnchecked', 'Usage not checked yet.')}
          </p>
        )}
      </div>
      <BuildReviewModelEffortFields
        capabilityMode={capabilityMode}
        usableOnly={usableOnly}
        role={role}
        agent={choice.agent}
        worktree={worktree}
        model={choice.model}
        effort={choice.effort}
        onChange={(next) => onChange({ agent: choice.agent, ...next })}
        defaultLabel={defaultLabel}
      />
    </>
  )
  if (appearance === 'row') {
    return (
      <BuildReviewSetupRow label={label} group>
        {fields}
      </BuildReviewSetupRow>
    )
  }
  return (
    <fieldset className="space-y-3 rounded-md border p-3">
      <legend className="px-1 text-sm font-medium">{label}</legend>
      {fields}
    </fieldset>
  )
}
