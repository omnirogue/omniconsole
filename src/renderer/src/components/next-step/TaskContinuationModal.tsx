import { useId, useRef, useState } from 'react'
import { Loader2, Play, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { BuildReviewModelEffortFields } from '@/components/build-review/BuildReviewAgentFields'
import {
  WorkflowError,
  WorkflowSelect,
  WorkflowTextField
} from '@/components/console-workflows/WorkflowFields'
import { workflowWorkspaceOptions } from '@/components/console-workflows/workflow-workspace-options'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useAgentDetectionTargetForWorktree } from '@/hooks/useAgentDetectionTarget'
import { useWorkAgentCapabilities } from '@/hooks/useWorkAgentCapabilities'
import { translate } from '@/i18n/i18n'
import { WorkflowRequestError, workflowErrorMessage } from '@/lib/console-workflow-client'
import { focusTaskConversation } from './focus-task-conversation'
import { useAppStore } from '@/store'
import { useAllWorktrees } from '@/store/selectors'
import { continueTaskExecution, type TaskContinuationModalData } from './task-continuation'
import { nextStepAgentName } from './next-step-summary'
import { taskContinuationInstruction } from './task-continuation-instruction'
import { AgentTemplateSelect } from '@/components/agent/AgentTemplateSelect'
import {
  rememberedTemplate,
  rememberTemplate
} from '@/components/sidebar/session-folders/new-conversation/launch-context'
import type { ConsoleTaskSetup } from '../../../../shared/console-task-setup'
import { AGENT_TEMPLATE_DEFAULT_ID } from '../../../../shared/agent-templates'
import { agentTemplateInstructions } from '../../../../shared/agent-template-dispatch'

export default function TaskContinuationModal(): React.JSX.Element {
  const data = useAppStore((state) => state.modalData as TaskContinuationModalData)
  const closeModal = useAppStore((state) => state.closeModal)
  return <TaskContinuationBody key={data.operationId} data={data} onClose={closeModal} />
}

export function TaskContinuationBody({
  data,
  onClose
}: {
  data: TaskContinuationModalData
  onClose: () => void
}): React.JSX.Element {
  const dismiss = () => {
    data.onCancelled?.()
    onClose()
  }
  const id = useId()
  const worktrees = useAllWorktrees()
  const folders = useAppStore((state) => state.folderWorkspaces)
  const [worktree, setWorktree] = useState('')
  const [instruction, setInstruction] = useState(data.instruction)
  const [choice, setChoice] = useState({ model: data.model, effort: data.effort })
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [taskSetup, setTaskSetup] = useState<ConsoleTaskSetup | null>(null)
  const [goalId, setGoalId] = useState('')
  // Why undefined until picked: the template follows each location's remembered one.
  const [pickedTemplate, setPickedTemplate] = useState<string | null | undefined>(undefined)
  const inFlight = useRef(false)
  const operationId = useRef(data.operationId)
  const options = workflowWorkspaceOptions(worktrees, folders)
  const worktreeId = worktree.startsWith('id:') ? worktree.slice(3) : worktree || null
  const settings = useAppStore((state) => state.settings)
  const remembered = worktreeId ? rememberedTemplate(settings, worktreeId).id : null
  const agentTemplateId =
    pickedTemplate !== undefined
      ? pickedTemplate
      : remembered === AGENT_TEMPLATE_DEFAULT_ID
        ? null
        : remembered
  const sent = taskContinuationInstruction(
    instruction,
    agentTemplateInstructions(settings?.agentTemplates, agentTemplateId)
  )
  const target = useAgentDetectionTargetForWorktree(worktreeId)
  const availability = useWorkAgentCapabilities(worktreeId, data.taskId, 'task-continuation')
  const available = availability.usable.find((entry) => entry.id === data.agent)
  const hasWorkspace = options.some((option) => option.value === worktree)
  const local = target?.kind === 'local'
  const model =
    choice.model ?? (available?.models.find((entry) => entry.isDefault) ?? available?.models[0])?.id
  const selectedModel = available?.models.find((entry) => entry.id === model)
  const effortOption = selectedModel?.options.find((option) => option.id === 'effort')
  const effortValid =
    !choice.effort ||
    (effortOption?.kind.type === 'select' &&
      effortOption.kind.choices.some((option) => option.value === choice.effort))
  const needsGoal = taskSetup?.gaps.includes('task_goal_missing') === true
  const goalOptions = (taskSetup?.goals ?? [])
    .filter((goal) => goal.status === 'active')
    .map((goal) => ({ value: goal.id, label: goal.title }))
  const goalReady = !needsGoal || goalOptions.some((option) => option.value === goalId)
  const canStart =
    hasWorkspace &&
    local &&
    !!selectedModel &&
    effortValid &&
    !!instruction.trim() &&
    !sent.tooLong &&
    goalReady
  const unavailableMessage =
    availability.continuationUnavailableReason ||
    translate(
      'conversations.workLocationAgentUnavailable',
      'This agent or model is no longer available for this work location. Refresh and choose another.'
    )
  const start = async (): Promise<void> => {
    if (inFlight.current || !canStart) {
      return
    }
    inFlight.current = true
    setPending(true)
    setError('')
    try {
      const verified = (await availability.refresh([data.agent])).find(
        (entry) => entry.id === data.agent && entry.status === 'usable'
      )
      const verifiedModel = verified?.models.find((entry) => entry.id === model)
      const verifiedEffort = verifiedModel?.options.find((option) => option.id === 'effort')
      if (
        !verifiedModel ||
        (choice.effort &&
          (verifiedEffort?.kind.type !== 'select' ||
            !verifiedEffort.kind.choices.some((option) => option.value === choice.effort)))
      ) {
        throw new Error(unavailableMessage)
      }
      // Pin the verified default so a retry never silently selects a different model.
      setChoice({ model: verifiedModel.id, effort: choice.effort })
      const execution = await continueTaskExecution({
        operationId: operationId.current,
        taskId: data.taskId,
        ...(data.threadId ? { threadId: data.threadId } : {}),
        agent: data.agent,
        model: verifiedModel.id,
        ...(choice.effort ? { effort: choice.effort } : {}),
        ...(goalId ? { goalId } : {}),
        instruction: sent.instruction,
        worktree
      })
      toast.success(
        translate('nextStep.continuationStarted', '{{agent}} started on this task.', {
          agent: nextStepAgentName(data.agent)
        })
      )
      onClose()
      try {
        await focusTaskConversation(execution)
      } catch {
        toast.warning(
          translate(
            'nextStep.continuationFocusFailed',
            'The agent started, but its conversation could not be opened; open it from your work list.'
          )
        )
      } finally {
        data.onStarted?.(execution)
      }
    } catch (cause) {
      if (
        cause instanceof WorkflowRequestError &&
        cause.detail.code === 'task_setup_required' &&
        cause.detail.taskSetup
      ) {
        setTaskSetup(cause.detail.taskSetup)
      }
      setError(workflowErrorMessage(cause))
    } finally {
      inFlight.current = false
      setPending(false)
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && !inFlight.current && dismiss()}>
      <DialogContent
        className="max-h-[calc(100vh-2rem)] overflow-y-auto scrollbar-sleek sm:max-w-xl"
        data-task-continuation
      >
        <DialogHeader>
          <DialogTitle>{translate('nextStep.continueTask', 'Continue this task')}</DialogTitle>
          <DialogDescription>
            {data.title} · {nextStepAgentName(data.agent)}
          </DialogDescription>
        </DialogHeader>
        <fieldset disabled={pending} className="space-y-3">
          {needsGoal ? (
            <div className="space-y-2">
              <WorkflowSelect
                label={translate(
                  'nextStep.continuationGoal',
                  'What outcome does this work support?'
                )}
                value={goalId}
                options={goalOptions}
                onChange={setGoalId}
                disabled={pending || goalOptions.length === 0}
              />
              <p className="text-xs text-muted-foreground">
                {goalOptions.length
                  ? translate(
                      'nextStep.continuationGoalHint',
                      'Choose an active company goal for this task, then start the agent.'
                    )
                  : translate(
                      'nextStep.continuationNoGoals',
                      'No active goals are available for this task. Add or activate a company goal before continuing.'
                    )}
              </p>
            </div>
          ) : null}
          <WorkflowSelect
            label={translate('nextStep.continuationWorkLocation', 'Work location')}
            value={worktree}
            options={options}
            onChange={setWorktree}
            disabled={pending}
          />
          <p className="text-xs text-muted-foreground">
            {options.length
              ? translate(
                  'nextStep.continuationLocationHint',
                  'Choose where this agent should work on this computer.'
                )
              : translate(
                  'nextStep.continuationNoLocations',
                  'Add a project or folder workspace, then return here to continue this task.'
                )}
          </p>
          <AgentTemplateSelect
            id={`${id}-agent-template`}
            value={agentTemplateId}
            onChange={(next) => {
              setPickedTemplate(next)
              if (worktreeId) {
                rememberTemplate(worktreeId, next ?? AGENT_TEMPLATE_DEFAULT_ID)
              }
            }}
            disabled={pending}
          />
          {worktree && !local ? (
            <WorkflowError
              message={translate(
                'nextStep.continuationRemoteUnavailable',
                'This work location is remote or its host is unknown. Choose a location on this computer to continue this task.'
              )}
            />
          ) : null}
          {hasWorkspace && local ? (
            <>
              <BuildReviewModelEffortFields
                role={id}
                agent={data.agent}
                taskId={data.taskId}
                capabilityMode="task-continuation"
                worktree={worktree}
                model={choice.model}
                effort={choice.effort}
                onChange={(next) => setChoice({ model: next.model, effort: next.effort })}
              />
              {availability.loading ? (
                <p role="status" className="text-xs text-muted-foreground">
                  {translate('nextStep.checkingAgent', 'Checking this agent and its models…')}
                </p>
              ) : !selectedModel || !effortValid ? (
                <WorkflowError message={unavailableMessage} />
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => void availability.refresh()}
              >
                <RefreshCw className="size-3.5" />
                {translate('nextStep.refreshAgent', 'Refresh agent availability')}
              </Button>
            </>
          ) : null}
          <WorkflowTextField
            label={translate('nextStep.instructions', 'Instructions')}
            value={instruction}
            onChange={setInstruction}
            disabled={pending}
            multiline
            prose
          />
          {sent.tooLong ? (
            <WorkflowError
              message={translate(
                'nextStep.continuationTemplateTooLong',
                'The instructions and the agent template together are over 32,000 characters. Shorten the instructions or choose a shorter template.'
              )}
            />
          ) : null}
        </fieldset>
        <WorkflowError message={error} />
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={dismiss}>
            {translate('common.cancel', 'Cancel')}
          </Button>
          <Button
            disabled={pending || availability.loading || !canStart}
            onClick={() => void start()}
            data-task-continuation-start
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
            {pending
              ? translate('nextStep.continuationStarting', 'Starting…')
              : translate('nextStep.startAgent', 'Start agent')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
