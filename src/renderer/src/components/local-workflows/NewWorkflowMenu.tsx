import type { ReactNode } from 'react'
import { Clock, MoreHorizontal, MessageSquare, Workflow, Zap } from 'lucide-react'
import {
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuItem,
  DropdownMenuLabel
} from '@/components/ui/dropdown-menu'
import type { HoverOpenContentProps } from '@/components/next-step/use-hover-open-popover'
import { translate } from '@/i18n/i18n'
import {
  OTHER_WORKFLOW_MENU_ORDER,
  PRIMARY_WORKFLOW_MENU_ORDER,
  WorkflowPresetIcon,
  workflowPresetDescription,
  workflowPresetLabel,
  workflowOpensOutsideLocalWorkspace,
  type WorkflowKind
} from './workflow-presets'

function MenuRow({ title, description }: { title: string; description: string }) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span>{title}</span>
      <span className="text-xs font-normal text-muted-foreground">{description}</span>
    </span>
  )
}

function WorkflowMenuItems({
  kinds,
  unavailableReason,
  onWorkflow
}: {
  kinds: readonly WorkflowKind[]
  unavailableReason?: string
  onWorkflow: (kind: WorkflowKind) => void
}) {
  return (
    <>
      {kinds.map((kind) => (
        <DropdownMenuItem
          key={kind}
          aria-label={workflowPresetLabel(kind)}
          className="items-start gap-2.5 py-2"
          disabled={!workflowOpensOutsideLocalWorkspace(kind) && Boolean(unavailableReason)}
          onSelect={() => onWorkflow(kind)}
        >
          <WorkflowPresetIcon preset={kind} className="mt-0.5 size-3.5 text-muted-foreground" />
          <MenuRow
            title={workflowPresetLabel(kind)}
            description={workflowPresetDescription(kind)}
          />
        </DropdownMenuItem>
      ))}
    </>
  )
}

export function NewWorkflowMenu({
  children,
  unavailableReason,
  hover,
  onWorkflow,
  onRoutine,
  onNeedSpeed
}: {
  children: ReactNode
  /** Why workflows cannot open here; Build + Review falls back to its dialog, Evolve opens anyway. */
  unavailableReason?: string
  hover: HoverOpenContentProps
  onWorkflow: (kind: WorkflowKind) => void
  /** Opens a new routine: a conversation that runs on a schedule. */
  onRoutine?: () => void
  onNeedSpeed?: () => void
}) {
  return (
    <>
      <DropdownMenuLabel className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {translate('conversations.newConversation', 'New conversation')}
      </DropdownMenuLabel>
      {onNeedSpeed ? (
        <DropdownMenuItem className="items-start gap-2.5 py-2" onSelect={onNeedSpeed}>
          <Zap aria-hidden="true" className="mt-0.5 size-3.5" />
          <MenuRow
            title={translate('needSpeed.title', 'Need Speed?')}
            description={translate(
              'needSpeed.menuDescription',
              'Route one or more prompts · Experimental'
            )}
          />
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuSub>
        <DropdownMenuSubTrigger
          aria-label={translate('localWorkflow.modelMenu', 'Model')}
          className="items-start gap-2.5 py-2"
        >
          <MessageSquare aria-hidden="true" className="mt-0.5 size-3.5" />
          <MenuRow
            title={translate('localWorkflow.modelMenu', 'Model')}
            description={translate(
              'localWorkflow.modelMenuDescription',
              'One model, a normal session'
            )}
          />
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="w-80" {...hover}>
          {children}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger
          aria-label={translate('localWorkflow.workflowMenu', 'Workflow')}
          className="items-start gap-2.5 py-2"
        >
          <Workflow aria-hidden="true" className="mt-0.5 size-3.5" />
          <MenuRow
            title={translate('localWorkflow.workflowMenu', 'Workflow')}
            description={translate(
              'localWorkflow.workflowMenuDescription',
              'Multi-agent workflows'
            )}
          />
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="w-80" {...hover}>
          <WorkflowMenuItems
            kinds={PRIMARY_WORKFLOW_MENU_ORDER}
            unavailableReason={unavailableReason}
            onWorkflow={onWorkflow}
          />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger
              aria-label={translate('localWorkflow.otherWorkflowsMenu', 'Other')}
              className="items-start gap-2.5 py-2"
            >
              <MoreHorizontal
                aria-hidden="true"
                className="mt-0.5 size-3.5 text-muted-foreground"
              />
              <MenuRow
                title={translate('localWorkflow.otherWorkflowsMenu', 'Other')}
                description={translate(
                  'localWorkflow.otherWorkflowsDescription',
                  'Improve, Find the best, Decide, Investigate, Audit, Build + Review'
                )}
              />
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-80" {...hover}>
              <WorkflowMenuItems
                kinds={OTHER_WORKFLOW_MENU_ORDER}
                unavailableReason={unavailableReason}
                onWorkflow={onWorkflow}
              />
              <DropdownMenuItem
                aria-label={translate('localWorkflow.describeMenu', 'Describe a workflow')}
                className="items-start gap-2.5 py-2"
                disabled={Boolean(unavailableReason)}
                onSelect={() => onWorkflow('custom')}
              >
                <WorkflowPresetIcon
                  preset="custom"
                  className="mt-0.5 size-3.5 text-muted-foreground"
                />
                <MenuRow
                  title={translate('localWorkflow.describeMenu', 'Describe a workflow')}
                  description={workflowPresetDescription('custom')}
                />
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {unavailableReason && (
            <p className="px-2 pt-1 pb-1.5 text-[11px] leading-4 whitespace-normal text-muted-foreground">
              {unavailableReason}
            </p>
          )}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      {onRoutine ? (
        <DropdownMenuItem
          aria-label={translate('localWorkflow.routineMenu', 'Routine')}
          className="items-start gap-2.5 py-2"
          onSelect={onRoutine}
        >
          <Clock aria-hidden="true" className="mt-0.5 size-3.5" />
          <MenuRow
            title={translate('localWorkflow.routineMenu', 'Routine')}
            description={translate(
              'localWorkflow.routineMenuDescription',
              'A conversation that runs on a schedule'
            )}
          />
        </DropdownMenuItem>
      ) : null}
    </>
  )
}
