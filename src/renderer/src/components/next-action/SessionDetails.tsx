import { useState, type ReactNode } from 'react'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { AttachToTaskDialog } from '@/components/tasks/AttachToTaskDialog'
import { CreateTaskDialog } from '@/components/tasks/CreateTaskDialog'
import { SessionTaskSheet } from '@/components/tasks/SessionTaskSheet'
import { selectConsoleAccountScope } from '@/lib/console-account-scope'
import { useAppStore } from '@/store'
import { SessionAgentTemplateFact } from './SessionAgentTemplateFact'
import { SessionLaunchFact } from './SessionLaunchFact'
import {
  agentBadgeLabel,
  countAndLatest,
  timingsLabel,
  type SessionDetailsFacts
} from './session-details-facts'

/** One read-only row: the fact's name, then its value. */
export function SessionDetailsFact({
  id,
  label,
  children
}: {
  id: string
  label: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-baseline gap-2 text-xs" data-next-action-fact={id}>
      <span className="min-w-[78px] shrink-0 text-muted-foreground">{label}</span>
      <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1">{children}</span>
    </div>
  )
}

/** A "More" row with a count and, when the mount wired a viewer, the link that opens it. */
function MoreFact({
  id,
  label,
  value,
  onOpen
}: {
  id: string
  label: string
  value: string
  onOpen?: () => void
}): React.JSX.Element {
  return (
    <SessionDetailsFact id={id} label={label}>
      <span>{value}</span>
      {onOpen ? (
        <Button
          type="button"
          variant="link"
          size="xs"
          className="h-auto px-1 text-xs text-muted-foreground"
          onClick={onOpen}
        >
          {translate('nextAction.open', 'open')}
        </Button>
      ) : null}
    </SessionDetailsFact>
  )
}

function WhereDot(): React.JSX.Element {
  return (
    <span aria-hidden className="text-muted-foreground">
      ·
    </span>
  )
}

export type SessionDetailsViewers = {
  onOpenReceipts?: () => void
  onOpenVerdicts?: () => void
  onOpenFiles?: () => void
}

/**
 * Surfaces a mount adds around the facts: the conversation header's Info panel puts the goal
 * and to-do list, then the live activity after the facts, the session's files and links after that, and the transcript
 * context inside More. Each is omitted when absent, so other mounts show only the facts.
 */
export type SessionDetailsSections = {
  /** The session's goal row and to-do list, right after the facts. */
  goalAndTodos?: ReactNode
  activity?: ReactNode
  filesAndLinks?: ReactNode
  more?: ReactNode
}

/** A titled block below the facts; its body is the surface the mount supplied. */
export function SessionDetailsSection({
  id,
  label,
  className,
  children
}: {
  id: string
  label: string
  className?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <section
      className={cn('min-w-0 space-y-1 border-t pt-2 text-xs', className)}
      data-next-action-section={id}
      aria-label={label}
    >
      <p className="font-medium text-muted-foreground">{label}</p>
      {children}
    </section>
  )
}

/**
 * The facts of this conversation, read-only: who is working, where it runs and which workspace on
 * one line, then its Conversations folder and task when it has them (an unlinked task's Create and
 * Attach live under More). Nothing here authors orchestration — the chain is the composer's
 * business, so there is no Plan, Done when or Up next row, and `Runs on` is a location, not an actor.
 * NA-5 hangs the dispatch menu on `runsOnMenu`; until then the row states the location and no more.
 */
export function SessionDetails({
  facts,
  runsOnMenu,
  viewers,
  sections,
  onTaskChanged
}: {
  facts: SessionDetailsFacts
  /** NA-5's dispatch menu for the location; absent means the row is plain text. */
  runsOnMenu?: ReactNode
  viewers?: SessionDetailsViewers
  sections?: SessionDetailsSections
  onTaskChanged?: () => void
}): React.JSX.Element {
  const scope = useAppStore(selectConsoleAccountScope)
  const [creating, setCreating] = useState(false)
  const [attaching, setAttaching] = useState(false)
  const [openedTask, setOpenedTask] = useState<string | null>(null)
  const { more } = facts
  return (
    <section
      className="space-y-2"
      data-next-action-session-details
      aria-label={translate('nextAction.sessionDetails', 'Session details')}
    >
      {/* Why one line: agent, location and workspace are context; five rows buried the result. */}
      <div
        className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs"
        data-next-action-where
      >
        <span
          className="flex min-w-0 items-center gap-1.5"
          data-next-action-fact="agent"
          title={translate('nextAction.agent', 'Agent')}
        >
          <span className="min-w-0 truncate font-medium">{facts.agent.name}</span>
          <span
            className={cn(
              'rounded px-1.5 py-0.5 text-[11px] leading-none',
              facts.agent.state === 'running'
                ? 'bg-status-success-background text-status-success'
                : 'bg-muted text-muted-foreground'
            )}
            title={facts.agent.detail ?? undefined}
            data-next-action-agent-state={facts.agent.state}
          >
            {agentBadgeLabel(facts.agent.state)}
          </span>
        </span>
        <WhereDot />
        <span
          className="flex min-w-0 items-center"
          data-next-action-fact="runs-on"
          title={translate('nextAction.runsOn', 'Runs on')}
        >
          {runsOnMenu ?? <span className="min-w-0 truncate">{facts.runsOn}</span>}
        </span>
        {facts.workspace ? (
          <>
            <WhereDot />
            <span
              className="min-w-0 truncate text-muted-foreground"
              data-next-action-fact="workspace"
              title={`${translate('nextAction.workspace', 'Workspace')}: ${facts.workspace}`}
            >
              {facts.workspace}
            </span>
          </>
        ) : null}
      </div>
      {facts.agentTemplate ? <SessionAgentTemplateFact template={facts.agentTemplate} /> : null}
      <SessionLaunchFact session={facts.session} />
      {sections?.activity ? (
        <section
          className="min-w-0 text-xs"
          data-next-action-section="activity"
          aria-label={translate('nextAction.activity', 'Activity')}
        >
          {sections.activity}
        </section>
      ) : null}
      {/* Why only a folder: otherwise "Saves to" repeats the workspace path. */}
      {facts.savesToFolder ? (
        <SessionDetailsFact id="saves-to" label={translate('nextAction.savesTo', 'Saves to')}>
          <span className="min-w-0 truncate" title={facts.savesTo}>
            {facts.savesTo}
          </span>
        </SessionDetailsFact>
      ) : null}
      {facts.task ? (
        <SessionDetailsFact id="task" label={translate('nextAction.task', 'Task')}>
          <span className="min-w-0 truncate" title={facts.task.title}>
            {facts.task.title}
          </span>
          <Button
            type="button"
            variant="link"
            size="xs"
            className="h-auto px-1 text-xs text-muted-foreground"
            onClick={() => setOpenedTask(facts.task?.id ?? null)}
          >
            {translate('nextAction.openTask', 'open')}
          </Button>
        </SessionDetailsFact>
      ) : null}
      {sections?.goalAndTodos}
      {sections?.filesAndLinks ? (
        <SessionDetailsSection
          id="files-and-links"
          label={translate('nextAction.filesAndLinks', 'Files & links')}
          className="has-[[data-files-links-empty]]:hidden"
        >
          {sections.filesAndLinks}
        </SessionDetailsSection>
      ) : null}
      <details className="text-xs text-muted-foreground" data-next-action-more>
        <summary className="w-max cursor-pointer select-none">
          {translate('nextAction.more', 'More')}
        </summary>
        <div className="mt-2 space-y-2">
          {facts.task ? null : (
            <SessionDetailsFact id="task" label={translate('nextAction.task', 'Task')}>
              <span>{translate('nextAction.none', 'none')}</span>
              <span aria-hidden>·</span>
              <Button
                type="button"
                variant="link"
                size="xs"
                className="h-auto px-0 text-xs"
                onClick={() => setCreating(true)}
              >
                {translate('nextAction.createTask', 'Create')}
              </Button>
              <span aria-hidden>·</span>
              <Button
                type="button"
                variant="link"
                size="xs"
                className="h-auto px-0 text-xs"
                onClick={() => setAttaching(true)}
              >
                {translate('nextAction.attachTask', 'Attach')}
              </Button>
            </SessionDetailsFact>
          )}
          <MoreFact
            id="receipts"
            label={translate('nextAction.receipts', 'Receipts')}
            value={countAndLatest(more.receipts)}
            onOpen={viewers?.onOpenReceipts}
          />
          <MoreFact
            id="verdicts"
            label={translate('nextAction.verdicts', 'Verdicts')}
            value={countAndLatest(more.verdicts)}
            onOpen={viewers?.onOpenVerdicts}
          />
          <MoreFact
            id="files"
            label={translate('nextAction.files', 'Files')}
            value={
              more.files.count
                ? translate('nextAction.filesChanged', '{{count}} changed', {
                    count: more.files.count
                  })
                : translate('nextAction.none', 'none')
            }
            onOpen={viewers?.onOpenFiles}
          />
          {/* Why: the mockup states timings inline; there is no timings viewer to link to. */}
          <MoreFact
            id="timings"
            label={translate('nextAction.timings', 'Timings')}
            value={timingsLabel(more.timings)}
          />
          {sections?.more}
        </div>
      </details>
      <CreateTaskDialog
        session={creating ? facts.session : null}
        onOpenChange={setCreating}
        onCreated={() => onTaskChanged?.()}
      />
      <AttachToTaskDialog
        session={attaching ? facts.session : null}
        onOpenChange={setAttaching}
        onAttached={() => onTaskChanged?.()}
      />
      {openedTask ? (
        <SessionTaskSheet
          key={`${scope}:${openedTask}`}
          taskId={openedTask}
          scope={scope}
          onClose={() => setOpenedTask(null)}
          onChanged={onTaskChanged}
        />
      ) : null}
    </section>
  )
}
