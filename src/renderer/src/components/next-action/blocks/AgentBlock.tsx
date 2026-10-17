import { CustomStageDialog } from '../advanced/CustomStageDialog'
import { SavedWorkflowMenu } from '../advanced/saved-workflow-menu'
import { AgentAdvanced } from '../advanced/AgentAdvanced'
import { useState } from 'react'
import { translate as t } from '@/i18n/i18n'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { defaultNextStepInstructions } from '../../../../../shared/next-step-draft'
import {
  UP_NEXT_MAX_SEATS_PER_STAGE,
  type UpNextAgentBlock,
  type UpNextAgentShape,
  type UpNextAgentTemplate,
  type UpNextView
} from '../../../../../shared/up-next-types'
import type { UpNextController } from '../use-up-next'
import { templateLabel, templateSubtitle } from '../up-next-labels'
import { upNextTemplateChoices } from '../../../../../shared/up-next-agent-intent'

const SHAPES: UpNextAgentShape[] = ['solo', 'parallel', 'council', 'best-of', 'custom']
export function AgentBlock({
  block,
  controller,
  view
}: {
  view: UpNextView
  block: UpNextAgentBlock
  controller: UpNextController
}) {
  const [editing, setEditing] = useState<'custom' | 'saved' | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const update = (patch: Parameters<UpNextController['update']>[1]) =>
    void controller.update(block.id, patch)
  return (
    <fieldset disabled={controller.disabled} className="min-w-0 space-y-2">
      <label className="flex flex-wrap items-center gap-2">
        <span className="min-w-16 text-muted-foreground">
          {t('upNext.templateLabel', 'Template')}
        </span>
        <Select
          value={block.template}
          disabled={controller.disabled}
          onValueChange={(value) => {
            const template = value as UpNextAgentTemplate
            update({
              kind: 'agent',
              template,
              instruction:
                template === 'custom' ? block.instruction : defaultNextStepInstructions(template)
            })
          }}
        >
          <SelectTrigger aria-label={t('upNext.templateLabel', 'Template')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {upNextTemplateChoices(block.template).map((template) => (
              <SelectItem key={template} value={template}>
                <span>{templateLabel(template)}</span>
                <span className="ml-2 text-muted-foreground">{templateSubtitle(template)}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-16 text-muted-foreground">{t('upNext.agents', 'Agents')}</span>
        <Select
          value={block.shape}
          disabled={controller.disabled}
          onValueChange={(shape) => {
            if (shape === 'custom' || shape === 'saved') {
              setEditing(shape)
              return
            }
            update({
              kind: 'agent',
              shape: shape as UpNextAgentShape,
              n: shape === 'solo' ? 1 : Math.max(2, block.n)
            })
          }}
        >
          <SelectTrigger aria-label={t('upNext.agents', 'Agents')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SHAPES.map((shape) => (
              <SelectItem key={shape} value={shape}>
                {shape === 'solo'
                  ? t('upNext.solo', '1 agent')
                  : shape === 'custom'
                    ? t('upNext.custom', 'Custom…')
                    : t(`upNext.shape.${shape}`, `{{n}} · ${shape}`, { n: Math.max(2, block.n) })}
              </SelectItem>
            ))}
            <SelectItem value="saved">
              {t('upNext.savedWorkflow.label', 'Saved workflow')}
            </SelectItem>
          </SelectContent>
        </Select>
        {(block.shape === 'parallel' || block.shape === 'custom') && (
          <span
            role="group"
            aria-label={t('upNext.agentCount', 'Number of agents')}
            className="inline-flex items-center gap-2"
          >
            <Button
              size="icon-xs"
              variant="outline"
              aria-label={t('upNext.fewerAgents', 'Fewer agents')}
              disabled={block.n <= 2}
              onClick={() => update({ kind: 'agent', n: Math.max(2, block.n - 1) })}
            >
              −
            </Button>
            <span>{block.n}</span>
            <Button
              size="icon-xs"
              variant="outline"
              aria-label={t('upNext.moreAgents', 'More agents')}
              disabled={block.n >= UP_NEXT_MAX_SEATS_PER_STAGE}
              onClick={() =>
                update({ kind: 'agent', n: Math.min(UP_NEXT_MAX_SEATS_PER_STAGE, block.n + 1) })
              }
            >
              +
            </Button>
          </span>
        )}
      </div>
      {editing === 'custom' && (
        <CustomStageDialog
          block={block}
          view={view}
          controller={controller}
          onClose={() => setEditing(null)}
        />
      )}
      {editing === 'saved' && (
        <SavedWorkflowMenu
          disabled={controller.disabled}
          stage={{
            kind: 'agent',
            template: block.template,
            shape: block.shape,
            n: block.n,
            instruction: block.instruction,
            advanced: block.advanced
          }}
          onUse={(stage) => update(stage)}
        />
      )}
      <Textarea
        key={block.instruction}
        defaultValue={block.instruction}
        aria-label={t('upNext.instruction', 'Instruction')}
        onBlur={(event) => {
          if (event.target.value !== block.instruction) {
            update({ kind: 'agent', instruction: event.target.value })
          }
        }}
      />
      <details onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
        <summary className="w-max cursor-pointer select-none text-muted-foreground">
          {t('upNext.advanced', 'Advanced')}
        </summary>
        {advancedOpen && <AgentAdvanced block={block} view={view} controller={controller} />}
      </details>
    </fieldset>
  )
}
