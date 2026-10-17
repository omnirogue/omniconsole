import { useCallback, useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { useAppStore } from '@/store'
import { selectSessionWorktrees } from '@/lib/session-row-details'
import { getSessionSidebarDrag } from '@/lib/session-sidebar-drag'
import { useSessionTeam } from '@/components/session-team/use-session-team'
import { useSessionDisplayTitle } from '@/components/goals-todos/use-session-display-title'
import { useSessionCompactContext } from '@/components/goals-todos/use-session-compact-context'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import {
  normalizeSessionCapabilities,
  type SessionCapabilities
} from '../../../../../shared/session-capabilities'
import { sessionHostLabel } from './session-technical-detail'
import { SessionRowHoverCardView } from './SessionRowHoverCardView'

type Props = {
  session: SidebarSession
  /** The plan that launched this row or runs after it. */
  chainId: string | null
  children: React.ReactNode
  /**
   * The row's own status and details block, built only once the card opens. A one-line row
   * keeps its agent, status line and reasons here instead of in the list.
   */
  renderDetails?: () => React.ReactNode
  /** True while a popover or menu of this row is open; the card stays shut until it closes. */
  isBusy?: () => boolean
}

/** Hover and keyboard focus both open the card after this pause; a pass over the list opens nothing. */
export const SESSION_ROW_HOVER_CARD_DELAY_MS = 350

const OPEN_LAYER_FROM_ROW = '[data-up-next-composer][data-state="open"]'

/**
 * The open state of a sidebar row's hover card, shared by every row kind (conversations,
 * routines): never opens over a drag, a menu or popover from the row, or an Up next composer,
 * and closes itself when a drag starts under it.
 */
export function useSessionRowHoverCardOpen(isBusy?: () => boolean): {
  open: boolean
  onOpenChange: (next: boolean) => void
} {
  const [open, setOpen] = useState(false)
  const onOpenChange = useCallback(
    (next: boolean) => {
      // Why: a card popping up under a row being dragged, or over a menu the person just opened
      // from the row, would cover what they are doing; only a plain hover or focus opens it.
      if (
        next &&
        (getSessionSidebarDrag() !== null ||
          isBusy?.() === true ||
          document.querySelector(OPEN_LAYER_FROM_ROW) !== null)
      ) {
        return
      }
      setOpen(next)
    },
    [isBusy]
  )
  useEffect(() => {
    if (!open) {
      return
    }
    // Why: a drag that starts under an open card gets no pointerleave; the card must go by itself.
    const close = (): void => setOpen(false)
    document.addEventListener('dragstart', close)
    return () => document.removeEventListener('dragstart', close)
  }, [open])
  return { open, onOpenChange }
}

export function SessionRowHoverCard({
  session,
  chainId,
  renderDetails,
  isBusy,
  children
}: Props): React.JSX.Element {
  const { open, onOpenChange } = useSessionRowHoverCardOpen(isBusy)
  return (
    <HoverCard
      open={open}
      onOpenChange={onOpenChange}
      openDelay={SESSION_ROW_HOVER_CARD_DELAY_MS}
      closeDelay={100}
    >
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      {/* Why: nothing below subscribes to the store until the card opens, so a 500-row list pays nothing. */}
      {open ? (
        <HoverCardContent
          side="right"
          align="start"
          sideOffset={8}
          className="w-80 max-h-[28rem] overflow-y-auto p-3 text-xs scrollbar-sleek"
        >
          <SessionRowHoverCardBody
            session={session}
            chainId={chainId}
            details={renderDetails?.() ?? null}
          />
        </HoverCardContent>
      ) : null}
    </HoverCard>
  )
}

function useSessionCapabilities(paneKey: string | null): SessionCapabilities | null {
  const [capabilities, setCapabilities] = useState<SessionCapabilities | null>(null)
  useEffect(() => {
    const read = window.api?.pty?.getSessionCapabilities
    if (!paneKey || !read) {
      return
    }
    let cancelled = false
    void read(paneKey)
      .then((reply) => {
        if (!cancelled) {
          setCapabilities(normalizeSessionCapabilities(reply))
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [paneKey])
  return capabilities
}

export function SessionRowHoverCardBody({
  session,
  chainId,
  details = null
}: Pick<Props, 'session' | 'chainId'> & { details?: React.ReactNode }): React.JSX.Element {
  const {
    team,
    entry,
    paneKey,
    chain,
    orchestrationChildren: children
  } = useSessionTeam(session, chainId)
  const displayTitle = useSessionDisplayTitle(session)
  const context = useSessionCompactContext(session, entry)
  const workspace = useAppStore(
    useShallow((state) => ({
      lineageById: state.worktreeLineageById,
      worktreesByRepo: state.worktreesByRepo,
      folderWorkspaces: state.folderWorkspaces,
      sshTargetLabels: state.sshTargetLabels,
      runtimeEnvironments: state.runtimeEnvironments
    }))
  )
  const capabilities = useSessionCapabilities(paneKey)

  const worktrees = useMemo(
    () =>
      selectSessionWorktrees({
        sessionWorktreeId: session.worktreeId,
        entry: entry ?? null,
        orchestrationChildren: children,
        lineageById: workspace.lineageById,
        worktreesByRepo: workspace.worktreesByRepo,
        folderWorkspaces: workspace.folderWorkspaces
      }),
    [session.worktreeId, entry, children, workspace]
  )
  const outcomeTitles = chain?.outcomeSet?.outcomes.map((outcome) => outcome.title) ?? []
  const linkedLine =
    entry?.orchestration?.taskTitle ?? (outcomeTitles.length > 0 ? outcomeTitles.join(' · ') : null)
  return (
    <SessionRowHoverCardView
      title={displayTitle}
      context={context}
      agent={entry?.agentType ?? session.agent ?? null}
      model={entry?.model ?? null}
      stateLabel={entry?.state ?? null}
      hostLabel={sessionHostLabel(
        session,
        workspace.sshTargetLabels,
        workspace.runtimeEnvironments
      )}
      team={team}
      worktrees={worktrees}
      capabilities={capabilities}
      linkedLine={linkedLine}
      details={details}
    />
  )
}
