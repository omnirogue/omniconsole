import { WorkflowOpenRouterPicker } from './WorkflowOpenRouterPicker'
import { useId, useMemo, useState } from 'react'
import { AgentTemplateSelect } from '@/components/agent/AgentTemplateSelect'
import { useAppStore } from '@/store'
import { resolveAgentTemplates } from '../../../../shared/agent-templates'
import { workflowSeatSystemFor, workflowSeatTemplate } from './workflow-seat-template'
import { ScrollText, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { WorkflowModelLogo } from '@/lib/workflow-model-logo'
import { WorkflowModelPicker } from './WorkflowModelPicker'
import type { WorkflowModelSource } from './workflow-model-sources'
import { localWorkflowRouteNamesModel } from '../../../../shared/local-workflow-seats'
import type { WorkflowPresetModel } from '../../../../shared/workflow-model-presets'
import type { WorkflowModelDefaults } from '../../../../shared/workflow-model-tiers'
import { ModelDot } from '@/components/ModelDot'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { WorkflowAgentSpec, WorkflowRoute } from '../../../../shared/workflow-graph'
import { WorkflowSelect } from './workflow-graph-controls'
import {
  workflowSeatModelOptions,
  type WorkflowSeatModelChoice
} from './workflow-seat-model-choices'

export const WORKFLOW_ROUTE_NAMES: Record<WorkflowRoute, string> = {
  claude: 'Claude',
  codex: 'GPT (Codex)',
  grok: 'Grok',
  gemini: 'Gemini',
  openrouter: 'OpenRouter',
  ollama: 'Ollama (local)'
}

/**
 * One seat of a step: its model family, an optional angle, and an optional system prompt that
 * says who this seat is and how it works. Seats of one family with different system prompts
 * compete like different models, and the judging record shows which of them win.
 */
export function WorkflowAgentRow({
  agent,
  routes,
  models,
  sources,
  modelDefaults,
  onModel,
  canRemove,
  judge,
  onRoute,
  onPatch,
  onRemove
}: {
  agent: WorkflowAgentSpec
  routes: readonly WorkflowRoute[]
  /** The route's selectable models; a picker shows only when it offers more than one. */
  models?: readonly WorkflowSeatModelChoice[]
  /** Every family and its models: with these the row shows the one model picker instead. */
  sources?: readonly WorkflowModelSource[]
  modelDefaults?: WorkflowModelDefaults
  onModel?: (model: WorkflowPresetModel) => void
  canRemove: boolean
  judge?: boolean
  onRoute: (route: WorkflowRoute) => void
  /** Typed text: kept as typed, normalized when the workflow is next read. */
  onPatch: (patch: Pick<WorkflowAgentSpec, 'angle' | 'system' | 'model'>) => void
  onRemove: () => void
}) {
  const [open, setOpen] = useState(Boolean(agent.system))
  const templateSelectId = useId()
  const stored = useAppStore((state) => state.settings?.agentTemplates)
  const templates = useMemo(() => resolveAgentTemplates(stored), [stored])
  const seatTemplate = workflowSeatTemplate(templates, agent.system)
  const templateCut = workflowSeatSystemFor(seatTemplate ?? undefined).cut
  const systemLabel = translate('workflowGraph.editor.systemPrompt', 'System prompt')
  const unified = !!sources?.length && !!onModel
  const modelPicker =
    !unified && !localWorkflowRouteNamesModel(agent.route) && models && models.length > 1
      ? workflowSeatModelOptions(models, agent.model)
      : undefined
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <ModelDot agent={agent.route} model={agent.model} />
        {unified ? (
          <WorkflowModelPicker
            value={agent}
            sources={sources}
            defaults={modelDefaults ?? {}}
            judge={judge}
            onChange={onModel}
          />
        ) : (
          <>
            <WorkflowModelLogo route={agent.route} model={agent.model} size={13} />
            <WorkflowSelect
              className="w-36"
              value={agent.route}
              // An Ollama seat names an installed model, which only the model picker lists.
              options={routes
                .filter((route) => route !== 'ollama' || agent.route === 'ollama')
                .map((route) => ({ value: route, label: WORKFLOW_ROUTE_NAMES[route] }))}
              onChange={(route) => onRoute(route as WorkflowRoute)}
            />
          </>
        )}
        {modelPicker && (
          <WorkflowSelect
            className="w-44"
            value={modelPicker.value}
            options={modelPicker.options}
            // The default model is left unnamed, so the agent shares its family's team seat.
            onChange={(model) =>
              onPatch({
                model: models?.some((entry) => entry.id === model && entry.isDefault)
                  ? undefined
                  : model
              })
            }
          />
        )}
        <Input
          className="h-8 flex-1 text-xs"
          value={agent.angle ?? ''}
          placeholder={translate('workflowGraph.editor.angle', 'Angle (optional)')}
          onChange={(event) => onPatch({ angle: event.target.value })}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={systemLabel}
          aria-pressed={open}
          title={systemLabel}
          onClick={() => setOpen(!open)}
        >
          <ScrollText
            className={cn('size-3.5', agent.system ? 'text-foreground' : 'text-muted-foreground')}
          />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={!canRemove}
          aria-label={translate('workflowGraph.editor.removeAgent', 'Remove agent')}
          onClick={onRemove}
        >
          <X className="size-3.5" />
        </Button>
      </div>
      {!unified && agent.route === 'openrouter' && (
        <WorkflowOpenRouterPicker
          model={agent.model}
          judge={judge}
          onChange={(model) => onPatch({ model })}
        />
      )}
      {open && (
        <AgentTemplateSelect
          id={templateSelectId}
          value={seatTemplate?.id ?? null}
          // Why the system field: seats already lead their calls with it; no new wire field.
          onChange={(id) =>
            onPatch({
              system: workflowSeatSystemFor(templates.find((template) => template.id === id)).system
            })
          }
        />
      )}
      {open && templateCut && (
        <p className="text-[11px] text-muted-foreground">
          {translate(
            'workflowGraph.editor.templateCut',
            'This template is longer than 4,000 characters, so the seat uses only its first 4,000.'
          )}
        </p>
      )}
      {open && (
        <Textarea
          rows={3}
          className="text-xs"
          aria-label={systemLabel}
          value={agent.system ?? ''}
          placeholder={translate(
            'workflowGraph.editor.systemPromptPlaceholder',
            'Optional: who this seat is and how it works, e.g. "You are a skeptical CFO. Cut anything that does not pay for itself."'
          )}
          onChange={(event) => onPatch({ system: event.target.value })}
        />
      )}
    </div>
  )
}
