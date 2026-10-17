import { useId, useState, type ReactNode } from 'react'
import { Bot, Building2, ChevronDown, ClipboardList, GitBranch } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { CreateTaskButton } from '@/components/tasks/CreateTaskButton'
import type { SessionChain } from '../../../../shared/session-chain-types'
import type { NextStepOutcomeDraft } from '../../../../shared/next-step-draft'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { NextStepOutcomeStatus } from './NextStepOutcomeStatus'
import { NextStepPlaceSelect } from './NextStepPlaceSelect'
import type { NextStepOutcomeFacts as Facts } from './next-step-outcome-facts'
import { nextStepAgentName } from './next-step-summary'
import { useHoverOpenPopover } from './use-hover-open-popover'

/** One muted line: an icon that says which fact, a screen-reader label, the value. */
export function Glance({
  id,
  icon,
  label,
  children,
  title
}: {
  id: string
  icon: ReactNode
  label: string
  children: ReactNode
  title?: string
}): React.JSX.Element {
  return (
    <div
      className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
      title={title}
      data-next-step-fact={id}
    >
      <span className="shrink-0 [&_svg]:size-3.5" aria-hidden>
        {icon}
      </span>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  )
}

/** The task as one line: its title, or "No task", and the control that creates or opens one. */
export function TaskGlance({ facts }: { facts: Facts }): React.JSX.Element {
  return (
    <Glance
      id="task"
      icon={<ClipboardList />}
      label={translate('nextStep.task', 'Task')}
      title={facts.task?.title}
    >
      <span className="min-w-0 truncate">
        {facts.task?.title ?? translate('nextStep.noTask', 'No task')}
      </span>
      <CreateTaskButton session={facts.session} />
    </Glance>
  )
}

/** Company → department as one line; the click opens the existing select. */
export function PlaceGlance({ facts }: { facts: Facts }): React.JSX.Element {
  return (
    <Glance
      id="place"
      icon={<Building2 />}
      label={translate('nextStep.companyDomain', 'Company / Domain')}
    >
      <NextStepPlaceSelect session={facts.session} flat />
    </Glance>
  )
}

/**
 * Everything else the dialog knows, behind one small "More": the agent and model, the
 * repository when the workspace is one, whichever of task and place the column did not show,
 * the progress with its verified conditions, and the notes for the agents.
 */
export function NextStepOutcomeFactsMore({
  facts,
  outcome,
  onOutcomeChange,
  chain,
  onChainChanged,
  onError,
  showsTask
}: {
  facts: Facts
  outcome: NextStepOutcomeDraft
  onOutcomeChange: (outcome: NextStepOutcomeDraft) => void
  chain: SessionChain | null
  onChainChanged: (chain: SessionChain) => void
  onError: (message: string) => void
  /** Whether the column already shows the task line (then the place goes here, and vice versa). */
  showsTask: boolean
}): React.JSX.Element {
  const notesId = useId()
  const [open, setOpen] = useState(false)
  const [notesOpen, setNotesOpen] = useState(false)
  const hover = useHoverOpenPopover({ open, onOpenChange: setOpen })
  const agent = nextStepAgentName(facts.session.agent as TuiAgent)
  // Why: a folder workspace has no repository; only a git worktree shows one, read-only.
  const repo = facts.repoId || facts.branch ? [facts.repoName, facts.branch] : null
  const notes = notesOpen || outcome.instructions.length > 0
  return (
    <Popover open={open} onOpenChange={hover.onOpenChange}>
      <PopoverAnchor asChild>
        <button
          type="button"
          className="inline-flex items-center gap-0.5 rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          aria-haspopup="dialog"
          aria-expanded={open}
          data-next-step-facts-more
          {...hover.anchorProps}
        >
          {translate('nextStep.more', 'More')}
          <ChevronDown className="size-3" aria-hidden />
        </button>
      </PopoverAnchor>
      <PopoverContent
        side="bottom"
        align="end"
        className="popover-wheel-scroll max-h-[min(480px,calc(100vh-2rem))] w-[min(360px,calc(100vw-1rem))] space-y-2 overflow-y-auto p-3 scrollbar-sleek"
        aria-label={translate('nextStep.details', 'Details')}
        {...hover.contentProps}
      >
        <Glance id="agent" icon={<Bot />} label={translate('nextStep.agentsWorkedHere', 'Agents')}>
          <span className="truncate">{facts.model ? `${agent} · ${facts.model}` : agent}</span>
        </Glance>
        {repo ? (
          <Glance
            id="repo"
            icon={<GitBranch />}
            label={translate('nextStep.repository', 'Repository')}
            title={repo.filter(Boolean).join(' @ ')}
          >
            <span className="truncate" data-next-step-repo>
              {translate('nextStep.repoAtBranch', 'Repo · {{where}}', {
                where: repo.filter(Boolean).join(' @ ')
              })}
            </span>
          </Glance>
        ) : null}
        {showsTask ? <PlaceGlance facts={facts} /> : <TaskGlance facts={facts} />}
        <NextStepOutcomeStatus
          session={facts.session}
          outcome={outcome}
          chain={chain}
          onChainChanged={onChainChanged}
          onError={onError}
        />
        {notes ? (
          <Textarea
            id={notesId}
            rows={2}
            className="text-xs"
            value={outcome.instructions}
            aria-label={translate('nextStep.notesForAgents', 'Notes for the agents')}
            placeholder={translate('nextStep.notesForAgents', 'Notes for the agents')}
            autoFocus={notesOpen && !outcome.instructions}
            onChange={(event) => onOutcomeChange({ ...outcome, instructions: event.target.value })}
          />
        ) : (
          <Button
            type="button"
            variant="link"
            size="xs"
            className="h-auto px-0 text-xs text-muted-foreground"
            onClick={() => setNotesOpen(true)}
          >
            {translate('nextStep.addNote', 'Add a note')}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  )
}
