import {
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleQuestionMark,
  CircleSlash,
  CircleX,
  MessageCircleQuestion
} from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { WorkflowPresetIcon } from '@/components/local-workflows/workflow-presets'
import { translate } from '@/i18n/i18n'
import type { LocalWorkflowTabStatus, SidebarWorkflow } from '@/lib/local-workflow-tab-status'
import { cn } from '@/lib/utils'

const GLYPHS = {
  running: Circle,
  'needs-you': MessageCircleQuestion,
  done: CircleCheck,
  failed: CircleX,
  stopped: CircleSlash,
  draft: Circle,
  unknown: CircleDashed,
  missing: CircleQuestionMark,
  unavailable: CircleAlert
} satisfies Record<LocalWorkflowTabStatus, typeof Circle>

const COLORS = {
  running: 'fill-current text-status-info motion-safe:animate-pulse',
  'needs-you': 'text-agent-question',
  done: 'text-status-success',
  failed: 'text-destructive',
  stopped: 'text-muted-foreground',
  draft: 'text-muted-foreground',
  unknown: 'text-muted-foreground',
  missing: 'text-muted-foreground',
  unavailable: 'text-muted-foreground'
} satisfies Record<LocalWorkflowTabStatus, string>

function workflowRowStateLabel(status: LocalWorkflowTabStatus): string {
  switch (status) {
    case 'running':
      return translate('conversations.workflowRunning', 'Working')
    case 'needs-you':
      return translate('conversations.workflowNeedsYou', 'Needs you')
    case 'done':
      return translate('conversations.workflowDone', 'Done')
    case 'failed':
      return translate('conversations.workflowFailed', 'Failed')
    case 'stopped':
      return translate('conversations.workflowStopped', 'Stopped')
    case 'draft':
      return translate('conversations.workflowDraft', 'Not started')
    case 'unknown':
      return translate('conversations.workflowUnknown', 'Checking its state…')
    case 'missing':
      return translate('conversations.workflowRunNotFound', 'Run not found')
    case 'unavailable':
      return translate('conversations.workflowStatusUnavailable', 'Status unavailable')
  }
}

/**
 * A workflow row's state and preset, as the tab strip shows them. A workflow has no pane, so no
 * terminal glyph: done reads as a green check, failed as a red cross and stopped as a grey slash,
 * so a finished run and a failed one never look alike.
 */
export function SessionSidebarRowWorkflowState({
  workflow,
  compact
}: {
  workflow: SidebarWorkflow
  compact: boolean
}): React.JSX.Element {
  const Icon = GLYPHS[workflow.status]
  const label = workflowRowStateLabel(workflow.status)
  const box = compact ? 'size-3' : 'size-4'
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn('inline-flex shrink-0 items-center justify-center', box)}
            role="img"
            aria-label={label}
            data-workflow-row-state={workflow.status}
          >
            <Icon className={cn(box, COLORS[workflow.status])} aria-hidden="true" />
          </span>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={6}>
          {label}
        </TooltipContent>
      </Tooltip>
      <WorkflowPresetIcon
        preset={workflow.preset}
        className={cn('shrink-0 text-muted-foreground', compact ? 'size-3' : 'size-3.5')}
      />
    </>
  )
}
