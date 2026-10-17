import { sessionAgentTemplateForChoice } from '../../../../shared/session-agent-template'
import { useState } from 'react'
import { Loader2, Play } from 'lucide-react'
import AgentCombobox from '@/components/agent/AgentCombobox'
import { AgentAccountSelect } from '@/components/agent/AgentAccountSelect'
import { AgentTemplateSelect } from '@/components/agent/AgentTemplateSelect'
import {
  rememberedTemplate,
  rememberTemplate
} from '@/components/sidebar/session-folders/new-conversation/launch-context'
import { BuildReviewModelEffortFields } from '@/components/build-review/BuildReviewAgentFields'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { launchAgentSessionContinuation } from '@/lib/launch-agent-session-continuation'
import {
  EMPTY_SESSION_ACTOR,
  resolveSessionActorLaunch,
  type SessionActorSelection
} from '@/lib/session-actor'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { useAppStore } from '@/store'
import type { LocalWorkflowView } from '../../../../shared/local-workflow-view'
import { AGENT_TEMPLATE_DEFAULT_ID } from '../../../../shared/agent-templates'
import { agentTemplateInstructions } from '../../../../shared/agent-template-dispatch'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { useSessionAgentChoice } from './use-session-agent-choice'
import type { WorkflowResultCandidate, WorkflowResults } from './workflow-results-candidates'
import {
  RESULTS_INSTRUCTION_LIMIT,
  workflowResultsSessionPrompt
} from './workflow-results-session-prompt'
import { workflowResultsStarters } from './workflow-results-starters'

/** Where a results session opens: the workflow conversation's workspace and tab group. */
export type WorkflowResultsTarget = { worktreeId: string; tabId: string }

function tabGroupFor(target: WorkflowResultsTarget): string | undefined {
  const state = useAppStore.getState()
  const source = state.unifiedTabsByWorktree[target.worktreeId]?.find(
    (entry) => entry.entityId === target.tabId || entry.id === target.tabId
  )
  return (
    source?.groupId ??
    state.activeGroupIdByWorktree[target.worktreeId] ??
    state.groupsByWorktree[target.worktreeId]?.[0]?.id
  )
}

/**
 * Starts an agent session with the chosen results in its first message. The instruction starts
 * as the usual one for the kind of result and is the person's to edit; left empty, the session
 * opens with the results in its composer for the person to finish there.
 */
export function WorkflowResultsLaunchDialog({
  target,
  view,
  results,
  chosen,
  onClose
}: {
  target: WorkflowResultsTarget
  view: LocalWorkflowView
  results: WorkflowResults
  chosen: WorkflowResultCandidate[]
  onClose: () => void
}) {
  const settings = useAppStore((state) => state.settings)
  const { agents, agent, setAgent, detecting, failed } = useSessionAgentChoice(target.worktreeId)
  // Model, effort and account belong to the CLI they were picked for, so a new agent starts clean.
  const [picked, setPicked] = useState<{ agent: TuiAgent | null; choice: SessionActorSelection }>({
    agent: null,
    choice: EMPTY_SESSION_ACTOR
  })
  const actor = picked.agent === agent ? picked.choice : EMPTY_SESSION_ACTOR
  const setActor = (update: (current: SessionActorSelection) => SessionActorSelection) =>
    setPicked({ agent, choice: update(actor) })
  const starters = workflowResultsStarters(
    results.kind,
    results.candidates.find((candidate) => candidate.decision)?.decision
  )
  const [instruction, setInstruction] = useState(starters[0]?.instruction ?? '')
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')
  // Why undefined until picked: the workspace's remembered template stays the live default.
  const [pickedTemplate, setPickedTemplate] = useState<string | null | undefined>(undefined)
  const remembered = rememberedTemplate(settings, target.worktreeId).id
  const agentTemplateId =
    pickedTemplate !== undefined
      ? pickedTemplate
      : remembered === AGENT_TEMPLATE_DEFAULT_ID
        ? null
        : remembered
  const draft = !instruction.trim()

  const start = async (): Promise<void> => {
    if (!agent || starting) {
      return
    }
    const workspacePath = useAppStore.getState().getKnownWorktreeById(target.worktreeId)?.path
    let prompt: string
    try {
      if (!workspacePath) {
        throw new Error(translate('resultsLaunch.noWorkspace', 'The workspace is unavailable.'))
      }
      prompt = workflowResultsSessionPrompt({
        view,
        results,
        chosen,
        instruction,
        worktreePath: workspacePath,
        agentTemplate: agentTemplateInstructions(settings?.agentTemplates, agentTemplateId)
      })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      return
    }
    setError('')
    setStarting(true)
    const { launchPreferences, launchEnv } = resolveSessionActorLaunch(settings, agent, actor)
    const launched = await launchAgentSessionContinuation({
      agent,
      prompt,
      agentTemplate: sessionAgentTemplateForChoice(settings?.agentTemplates, agentTemplateId),
      worktreeId: target.worktreeId,
      groupId: tabGroupFor(target),
      workspacePath,
      launchSource: 'workflow_follow_up',
      launchPreferences,
      launchEnv,
      // Why terminal: the chat lanes drop or refuse a draft; the terminal keeps it in the composer.
      ...(draft
        ? { promptDelivery: 'draft' as const, viewModePreference: 'terminal' as const }
        : {}),
      onLaunched: (launch) => {
        if (launch.tabId) {
          activateTabAndFocusPane(launch.tabId, null)
        }
      }
    })
    setStarting(false)
    if (launched) {
      onClose()
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !starting) {
          onClose()
        }
      }}
    >
      <DialogContent className="min-w-0 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Play className="size-4" />
            {translate('resultsLaunch.dialogTitle', 'Start a session with {{count}} chosen', {
              count: chosen.length
            })}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {translate(
              'resultsLaunch.dialogDescription',
              'The session gets each chosen result in full, where it is in the code, the scores and verdicts, and where the run saved its results.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="min-w-0 space-y-4">
          <ul
            aria-label={translate('resultsLaunch.chosen', 'Chosen')}
            className="max-h-28 min-w-0 space-y-0.5 overflow-y-auto rounded-md border border-border bg-muted/30 px-3 py-2 text-xs scrollbar-sleek"
          >
            {chosen.map((candidate) => (
              <li key={candidate.id} className="truncate">
                {candidate.title}
                {candidate.location ? (
                  <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">
                    {candidate.location}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          <div className="min-w-0 space-y-1.5">
            <label className="text-xs font-medium">
              {translate('resultsLaunch.agent', 'Agent')}
            </label>
            <AgentCombobox
              agents={agents}
              value={agent}
              onValueChange={setAgent}
              allowBlankTerminal={false}
              allowNarrowTrigger
              emptyLabel={translate('resultsLaunch.selectAgent', 'Select an agent')}
              triggerClassName="min-w-0 w-full"
            />
            {detecting ? (
              <p className="text-[11px] text-muted-foreground">
                {translate('resultsLaunch.detecting', 'Finding the agents on this workspace…')}
              </p>
            ) : failed || agents.length === 0 ? (
              <p className="text-[11px] text-destructive">
                {translate(
                  'resultsLaunch.noAgents',
                  'No enabled agents were found on this workspace.'
                )}
              </p>
            ) : null}
          </div>
          {agent ? (
            <>
              <BuildReviewModelEffortFields
                role="results-launch"
                agent={agent}
                worktree={toRuntimeWorktreeSelector(target.worktreeId)}
                model={actor.model}
                effort={actor.effort}
                onChange={(next) =>
                  setActor((current) => ({
                    ...next,
                    ...(current.accountChoiceId ? { accountChoiceId: current.accountChoiceId } : {})
                  }))
                }
              />
              <AgentAccountSelect
                id="results-launch-account"
                agent={agent}
                value={actor.accountChoiceId ?? null}
                onChange={(accountChoiceId) =>
                  setActor((current) => ({ ...current, accountChoiceId }))
                }
              />
              <AgentTemplateSelect
                id="results-launch-agent-template"
                value={agentTemplateId}
                onChange={(next) => {
                  setPickedTemplate(next)
                  rememberTemplate(target.worktreeId, next ?? AGENT_TEMPLATE_DEFAULT_ID)
                }}
                disabled={starting}
              />
            </>
          ) : null}
          <div className="min-w-0 space-y-1.5">
            <label htmlFor="results-launch-instruction" className="text-xs font-medium">
              {translate('resultsLaunch.instruction', 'What should it do?')}
            </label>
            <div className="flex flex-wrap gap-1">
              {starters.map((starter) => (
                <Button
                  key={starter.id}
                  type="button"
                  size="xs"
                  variant={instruction === starter.instruction ? 'secondary' : 'outline'}
                  onClick={() => setInstruction(starter.instruction)}
                >
                  {starter.label}
                </Button>
              ))}
              <Button
                type="button"
                size="xs"
                variant={draft ? 'secondary' : 'outline'}
                onClick={() => setInstruction('')}
              >
                {translate('resultsLaunch.writeInSession', 'Write it in the session')}
              </Button>
            </div>
            <Textarea
              id="results-launch-instruction"
              rows={4}
              maxLength={RESULTS_INSTRUCTION_LIMIT}
              value={instruction}
              placeholder={translate(
                'resultsLaunch.instructionPlaceholder',
                'Leave empty to type the instruction in the session instead.'
              )}
              onChange={(event) => setInstruction(event.target.value)}
            />
            <p className="text-[11px] leading-4 text-muted-foreground">
              {draft
                ? translate(
                    'resultsLaunch.draftHint',
                    'The session opens in the terminal with the results typed in and not sent: add what it should do there, then send.'
                  )
                : translate(
                    'resultsLaunch.sendHint',
                    'The results and this instruction are sent as the first message.'
                  )}
            </p>
          </div>
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={starting} onClick={onClose}>
            {translate('resultsLaunch.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            disabled={detecting || starting || !agent}
            onClick={() => void start()}
          >
            {starting ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {draft
              ? translate('resultsLaunch.open', 'Open session')
              : translate('resultsLaunch.start', 'Start session')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
