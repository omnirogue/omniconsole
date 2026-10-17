import { CollisionBanner } from '../team-sessions/CollisionBanner'
import { useSessionLedgerSidebar } from '../team-sessions/use-session-ledger-sidebar'
import { Suspense, type ReactNode } from 'react'
import { FolderGit2, ListChecks, SquareTerminal, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { lazyWithRetry } from '@/lib/lazy-with-retry'

const SessionSidebar = lazyWithRetry(() => import('./SessionSidebar'))

const TeamSessionsSidebar = lazyWithRetry(() => import('../team-sessions/TeamSessionsSidebar'))
const GoalsTodosSidebar = lazyWithRetry(() => import('@/components/goals-todos/GoalsTodosSidebar'))

// Why content-sized and shrinkable: each view keeps its label's width while there is room, and a
// narrow sidebar truncates the labels instead of pushing the row past its container.
const ITEM_CLASS =
  'min-w-0 flex-auto shrink px-2 text-xs data-[state=on]:bg-worktree-sidebar-accent data-[state=on]:text-worktree-sidebar-accent-foreground'

function Loading(): React.JSX.Element {
  return (
    <p className="px-4 py-2 text-xs text-muted-foreground">
      {translate('auto.components.SessionSidebar.loadingSessions', 'Loading sessions…')}
    </p>
  )
}

/**
 * Conversations is the human view of a session (by attention, named, filed);
 * Sessions is the same underlying sessions read as a technical row (agent,
 * model, host, workspace); Workspaces — behind the wrench — is the folder
 * tree for people who think in repositories. Goals & to-dos — behind the checklist — reads
 * the same sessions once more, as what each is for and how far through its list it is. This tab
 * is the only place the sidebar says "Conversations"; a row opens its conversation. Routines are
 * conversations with a schedule, so they are listed here too, not behind a tab of their own.
 */
export function SidebarSessionSurface({ children }: { children: ReactNode }) {
  // Why: the Work home and the navigation switch this tree too, so the choice lives in the store.
  const teamCount = useSessionLedgerSidebar()
  const surface = useAppStore((state) => state.sidebarSessionSurface)
  const setSurface = useAppStore((state) => state.setSidebarSessionSurface)
  const developerWorkspacesLabel = translate(
    'auto.components.SessionSidebar.developerWorkspacesLabel',
    'Developer Workspaces'
  )
  const goalsTodosLabel = translate('goalsTodos.title', 'Goals & to-dos')
  const developerWorkspacesDescription = translate(
    'auto.components.SessionSidebar.developerWorkspacesDescription',
    'View repos, worktrees, branches, folders and workspace configuration.'
  )
  return (
    <>
      {/* Why wrap: the three views and the three view buttons need about 350px. A 280px sidebar
          used to lay the buttons out past its edge, hidden but focusable, so Tab scrolled the whole
          sidebar sideways; now they move to their own line until the sidebar is wide enough. */}
      <div className="mx-2 mb-1 flex flex-wrap items-center justify-end gap-1">
        <ToggleGroup
          type="single"
          size="sm"
          value={surface === 'workspaces' ? '' : surface}
          onValueChange={(value) => {
            if (value === 'sessions' || value === 'team') {
              setSurface(value)
            }
          }}
          aria-label={translate('auto.components.SessionSidebar.sidebarView', 'Sidebar view')}
          className="w-auto min-w-0 flex-auto"
        >
          <ToggleGroupItem value="sessions" className={ITEM_CLASS}>
            <span className="truncate">{translate('conversations.heading', 'Conversations')}</span>
          </ToggleGroupItem>
          <ToggleGroupItem value="team" className={ITEM_CLASS}>
            <span className="relative">
              <Users className="size-3.5" />
              {teamCount > 0 ? (
                <span className="absolute -right-2 -top-2 rounded-full bg-sidebar-accent px-1 text-[11px] text-sidebar-accent-foreground">
                  {teamCount}
                </span>
              ) : null}
            </span>
            <span className="truncate">{translate('nextStep.people', 'People')}</span>
          </ToggleGroupItem>
        </ToggleGroup>
        <div className="flex shrink-0 items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant={surface === 'technical' ? 'secondary' : 'ghost'}
                size="icon-sm"
                aria-label={translate(
                  'auto.components.SessionSidebar.technicalSessions',
                  'Sessions'
                )}
                aria-pressed={surface === 'technical'}
                onClick={() => setSurface('technical')}
              >
                <SquareTerminal className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {translate('auto.components.SessionSidebar.technicalSessions', 'Sessions')}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant={surface === 'goals' ? 'secondary' : 'ghost'}
                size="icon-sm"
                aria-label={goalsTodosLabel}
                aria-pressed={surface === 'goals'}
                onClick={() => setSurface('goals')}
              >
                <ListChecks className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{goalsTodosLabel}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant={surface === 'workspaces' ? 'secondary' : 'ghost'}
                size="icon-sm"
                aria-label={developerWorkspacesLabel}
                aria-pressed={surface === 'workspaces'}
                onClick={() => setSurface('workspaces')}
              >
                <FolderGit2 className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-64">
              <p className="font-medium">{developerWorkspacesLabel}</p>
              <p className="text-muted-foreground">{developerWorkspacesDescription}</p>
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
      <CollisionBanner />
      {surface === 'sessions' || surface === 'technical' ? (
        <Suspense fallback={<Loading />}>
          <SessionSidebar technical={surface === 'technical'} />
        </Suspense>
      ) : surface === 'goals' ? (
        <Suspense fallback={<Loading />}>
          <GoalsTodosSidebar />
        </Suspense>
      ) : surface === 'team' ? (
        <Suspense fallback={<Loading />}>
          <TeamSessionsSidebar />
        </Suspense>
      ) : (
        children
      )}
    </>
  )
}
