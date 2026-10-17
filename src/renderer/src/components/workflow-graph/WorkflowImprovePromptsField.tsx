import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import type {
  WorkflowImprovePromptKey,
  WorkflowImprovePrompts
} from '../../../../shared/workflow-graph'
import { WORKFLOW_IMPROVE_DEFAULT_PROMPTS } from '../../../../shared/workflow-improve-prompts'
import { WorkflowSelect } from './workflow-graph-controls'

function promptOptions(): { value: WorkflowImprovePromptKey; label: string }[] {
  return [
    {
      value: 'rules',
      label: translate('workflowGraph.improve.prompt.rules', 'Rules for every version')
    },
    { value: 'first', label: translate('workflowGraph.improve.prompt.first', 'First version') },
    {
      value: 'improve',
      label: translate('workflowGraph.improve.prompt.improve', 'Improving the best version')
    },
    {
      value: 'explore',
      label: translate('workflowGraph.improve.prompt.explore', 'Trying a different approach')
    },
    {
      value: 'divergent',
      label: translate('workflowGraph.improve.prompt.divergent', 'After improving stops helping')
    }
  ]
}

/**
 * Improve's built-in instructions, one at a time. The box shows the wording a run will use;
 * editing it keeps the person's own, and emptying it goes back to the built-in wording.
 */
export function WorkflowImprovePromptsField({
  prompts,
  onChange
}: {
  prompts: WorkflowImprovePrompts | undefined
  onChange: (prompts: WorkflowImprovePrompts | undefined) => void
}) {
  const [key, setKey] = useState<WorkflowImprovePromptKey>('rules')
  const own = prompts?.[key]
  const set = (text: string | undefined) => {
    const { [key]: _previous, ...rest } = prompts ?? {}
    const next = text?.trim() ? { ...rest, [key]: text } : rest
    onChange(Object.keys(next).length ? next : undefined)
  }
  const reworded = Object.keys(prompts ?? {}).length
  return (
    <div className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
      {translate('workflowGraph.improve.prompts', 'Prompts (optional)')}
      <WorkflowSelect
        value={key}
        options={promptOptions()}
        onChange={(value) => setKey(value as WorkflowImprovePromptKey)}
      />
      <Textarea
        rows={5}
        className="text-xs"
        aria-label={translate('workflowGraph.improve.promptText', 'Prompt wording')}
        value={own ?? WORKFLOW_IMPROVE_DEFAULT_PROMPTS[key]}
        onChange={(event) => set(event.target.value)}
      />
      <span className="flex flex-wrap items-center gap-2 font-normal">
        {own === undefined ? (
          translate(
            'workflowGraph.improve.promptBuiltIn',
            'The built-in wording. Edit it to use your own.'
          )
        ) : (
          <Button
            type="button"
            variant="link"
            size="xs"
            className="px-0"
            onClick={() => set(undefined)}
          >
            {translate('workflowGraph.improve.promptReset', 'Use the built-in wording')}
          </Button>
        )}
        {reworded ? (
          <span>
            {translate('workflowGraph.improve.promptsReworded', '{{count}} reworded', {
              count: reworded
            })}
          </span>
        ) : null}
      </span>
    </div>
  )
}
