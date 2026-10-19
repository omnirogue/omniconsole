import { SessionTagPicker } from './SessionTagPicker'
import { useMemo, useState } from 'react'
import {
  Archive,
  ArchiveRestore,
  BookmarkMinus,
  History,
  MessageSquare,
  MoreVertical,
  Play,
  Plus,
  Trash2,
  X
} from 'lucide-react'
import { closeTerminalTab } from '@/components/terminal/terminal-tab-actions'
import { UpNextControls } from '@/components/next-action/UpNextControls'
import { UpNextPopover } from '@/components/next-action/UpNextPopover'
import { UP_NEXT_COMPOSER_ENABLED } from '@/components/next-action/up-next-composer-flag'
import { SessionPlanLock } from '@/components/next-step/SessionPlanLock'
import { useSessionChainForRow } from '@/lib/session-chain-registry'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { conversationViewKey } from '@/lib/conversation-view'
import type { SessionChainRowInfo } from '@/lib/session-chain-runner'
import { getSessionFolderId, isSavedSessionFolder } from '@/lib/session-folders'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import {
  archiveSessionsByPerson,
  moveSessionsByPerson
} from '@/lib/session-organization-person-changes'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { useSessionHistoryOpen } from '@/store/session-history-open'
import { ConversationArchiveButton } from './ConversationArchiveButton'
import { PersonalHideButton } from './PersonalHideButton'
import { ROW_HOVER_REVEAL, ROW_HOVER_YIELD } from './session-row-reveal'
import { useDeleteSidebarSessions } from './session-delete'
import { retainWorkerAsConversation } from './session-sidebar-row-actions'
import { SessionSleepMenuItem } from './SessionSleepMenuItem'
import { SessionWorkflowRecheckMenuItem } from './SessionWorkflowRecheckMenuItem'
import { isArchivedOnController, noteArchivedOnController } from '@/lib/mirrored-workflow-archive'
import {
  ledgerOnlyRowRefusal,
  ownerPlacedRowRefusal
} from '@/lib/mirrored-conversation-row-actions'

/**
 * The controls at the right edge of a Conversations row. Hide, Archive and Tags show on hover for
 * every row; the plan's lock, the queue's ✕ and the idle ⋮ ＋ sit beside them by state. Hover-only
 * controls take no width until they show, so a resting row gives its width to the name; on a
 * narrow row Hide, Archive and Tags fold away from the end instead of squeezing the name.
 */
export function SessionSidebarRowActions({
  session,
  workerDispatchId,
  workerProcessIncarnation,
  chain,
  launchedBy = null,
  queued,
  queueRefusal,
  hidden,
  archived = false,
  onToggleHidden,
  onCancelQueue,
  onStartChain
}: {
  session: SidebarSession
  workerDispatchId?: string
  workerProcessIncarnation?: string
  chain: SessionChainRowInfo | null
  launchedBy?: SessionChainRowInfo | null
  queued: boolean
  queueRefusal: string | null
  hidden: boolean
  /** The row sits under Archived (by age or by hand). */
  archived?: boolean
  onToggleHidden: () => void
  onCancelQueue: () => void
  onStartChain?: () => void
}): React.JSX.Element {
  const tagSessions = useMemo(() => [session], [session])
  const boundChain = useSessionChainForRow(session.rowKey)
  const hasBoundOutcome = Boolean(boundChain?.outcomeSet)
  const [moreOpen, setMoreOpen] = useState(false)
  const [upNextOpen, setUpNextOpen] = useState(false)
  const [retaining, setRetaining] = useState(false)
  const key = conversationViewKey(session)
  const saved = useSessionFolders((state) =>
    isSavedSessionFolder(state.metadata, getSessionFolderId(state.metadata, key))
  )
  const locallyArchived = useSessionSidebarView((state) => state.archived.includes(key))
  const archivedByHand = session.ownerArchive?.byHand ?? locallyArchived
  // Why: a mirrored workflow its controller archived is unarchived there (step 9).
  const ownerArchived = archived && isArchivedOnController(session)
  const liveChain = chain !== null && !['failed', 'done', 'cancelled'].includes(chain.state)
  const deleteSessions = useDeleteSidebarSessions()
  const deleteLabel = translate('conversations.deleteItem', 'Delete {{name}}', {
    name: session.label
  })
  // Why (E1/F13): a row the owner's ledger created runs there; what would change it here is off.
  const ledgerRefusal = ledgerOnlyRowRefusal(session)
  // Why apart (E1 for filing): a row its owner places is filed there, so it is not unfiled here.
  const placeRefusal = ownerPlacedRowRefusal(session)
  const keepAsConversation = async (): Promise<void> => {
    if (!workerDispatchId || !workerProcessIncarnation || !session.paneKey || retaining) {
      return
    }
    setRetaining(true)
    try {
      await retainWorkerAsConversation({
        workerDispatchId,
        workerProcessIncarnation,
        paneKey: session.paneKey
      })
    } finally {
      setRetaining(false)
    }
  }
  return (
    <>
      {workerDispatchId && workerProcessIncarnation && session.paneKey ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              data-worker-keep-as-conversation=""
              aria-label={translate(
                'conversations.keepWorkerAsConversation',
                'Keep {{name}} as a conversation',
                {
                  name: session.label
                }
              )}
              disabled={retaining}
              onClick={() => void keepAsConversation()}
            >
              <MessageSquare className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {translate('conversations.keepAsConversation', 'Keep as conversation')}
          </TooltipContent>
        </Tooltip>
      ) : null}
      {chain?.state === 'ready' && onStartChain ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="shrink-0 text-agent-question"
              data-session-row-start=""
              aria-label={translate(
                'components.sessionChain.startNextAfter',
                'Start the next queued session after {{session}}',
                { session: session.label }
              )}
              onClick={onStartChain}
            >
              <Play className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {translate('components.sessionChain.startNext', 'Start next')}
          </TooltipContent>
        </Tooltip>
      ) : null}
      {/* Why first and on every row: putting a row away — for now or for good — must never
          depend on what its plan is doing. Why Tags last: it folds away first, and "Tag
          selected" still reaches it. Why its icon alone: the row's controls leave the name its
          floor at the default sidebar width only as three 1.5rem icons. */}
      <span className={ROW_HOVER_YIELD} data-session-row-yield="">
        <PersonalHideButton hidden={hidden} name={session.label} onClick={onToggleHidden} />
        {/* Why: Archive is the one-click way to put any row away, saved ones included; only a
            row archived by hand can be unarchived — one aged into Archived has nothing to undo. */}
        {archivedByHand || !archived || ownerArchived ? (
          <ConversationArchiveButton
            archivedByHand={archivedByHand || ownerArchived}
            name={session.label}
            disabledReason={ledgerRefusal}
            onClick={() =>
              ownerArchived && !archivedByHand
                ? noteArchivedOnController(session)
                : archiveSessionsByPerson([key], !archivedByHand)
            }
          />
        ) : null}
        {/* Why only under Archived: like the Mac's Trash, a row is archived first and deleted
            from there. */}
        {archived ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                className="hover:text-destructive"
                data-session-row-delete=""
                aria-label={deleteLabel}
                disabled={ledgerRefusal !== null}
                title={ledgerRefusal ?? undefined}
                onClick={() => void deleteSessions([session])}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{ledgerRefusal ?? deleteLabel}</TooltipContent>
          </Tooltip>
        ) : null}
        <SessionTagPicker sessions={tagSessions} iconOnly />
      </span>
      {hasBoundOutcome ? (
        <UpNextControls subject={{ kind: 'session', session }} />
      ) : liveChain ? (
        <>
          <SessionPlanLock chain={chain} />
          <span className={ROW_HOVER_REVEAL}>
            <Button
              variant="ghost"
              size="icon-xs"
              className="shrink-0"
              onClick={onCancelQueue}
              aria-label={translate(
                'components.sessionChain.cancelPlanAfter',
                'Cancel the plan after {{session}}',
                { session: session.label }
              )}
            >
              <X className="size-3.5" />
            </Button>
          </span>
        </>
      ) : queued ? (
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onCancelQueue}
          // Why: dismissing a failure and cancelling work still to come are different acts.
          aria-label={
            chain?.state === 'failed'
              ? translate(
                  'components.sessionChain.dismissFailedAfter',
                  'Dismiss the failed queue after {{session}}',
                  { session: session.label }
                )
              : translate(
                  'auto.components.SessionSidebar.cancelQueuedAfter',
                  'Cancel queued session after {{session}}',
                  { session: session.label }
                )
          }
        >
          <X className="size-3.5" />
        </Button>
      ) : launchedBy ? (
        <SessionPlanLock chain={launchedBy} />
      ) : (
        <span
          className={ROW_HOVER_REVEAL}
          // Why: the composer hangs off ⋮ with no expanded trigger of its own; its anchor must
          // stay where it opened while the pointer is inside it.
          data-pinned={moreOpen || upNextOpen || undefined}
        >
          {/* Why: the composer is hoisted OUT of the ⋮ menu content — rendered inside it, closing
              the menu would unmount the composer the person just opened. */}
          <UpNextPopover
            subject={{ kind: 'session', session }}
            open={upNextOpen}
            onOpenChange={setUpNextOpen}
            anchor={
              <span className="flex">
                <Popover open={moreOpen} onOpenChange={setMoreOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={translate('nextStep.moreOptions', 'More options')}
                      aria-haspopup="menu"
                    >
                      <MoreVertical className="size-3.5" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    side="right"
                    align="start"
                    className="w-56 p-1"
                    role="menu"
                    // Why: closing the menu must not pull focus back to ⋮ — that lands outside the
                    // composer this click just opened, and Radix would dismiss it again at once.
                    onCloseAutoFocus={(event) => event.preventDefault()}
                  >
                    {UP_NEXT_COMPOSER_ENABLED ? (
                      <Button
                        variant="ghost"
                        size="xs"
                        role="menuitem"
                        aria-label={translate('upNext.title', 'Up next')}
                        className="w-full justify-start gap-2"
                        disabled={Boolean(queueRefusal)}
                        title={queueRefusal ?? undefined}
                        onClick={() => {
                          setMoreOpen(false)
                          setUpNextOpen(true)
                        }}
                      >
                        <Plus className="size-3.5" />
                        {translate('upNext.title', 'Up next')}
                      </Button>
                    ) : null}
                    {saved ? (
                      <Button
                        variant="ghost"
                        size="xs"
                        role="menuitem"
                        className="w-full justify-start gap-2"
                        disabled={placeRefusal !== null}
                        title={placeRefusal ?? undefined}
                        onClick={() => {
                          moveSessionsByPerson([key], null)
                          setMoreOpen(false)
                        }}
                      >
                        <BookmarkMinus className="size-3.5" />
                        {translate('conversations.removeFromSaved', 'Remove from Saved Sessions')}
                      </Button>
                    ) : null}
                    {archivedByHand || !archived || ownerArchived ? (
                      <Button
                        variant="ghost"
                        size="xs"
                        role="menuitem"
                        className="w-full justify-start gap-2"
                        disabled={ledgerRefusal !== null}
                        title={ledgerRefusal ?? undefined}
                        onClick={() => {
                          if (ownerArchived && !archivedByHand) {
                            noteArchivedOnController(session)
                          } else {
                            archiveSessionsByPerson([key], !archivedByHand)
                          }
                          setMoreOpen(false)
                        }}
                      >
                        {archivedByHand || ownerArchived ? (
                          <ArchiveRestore className="size-3.5" />
                        ) : (
                          <Archive className="size-3.5" />
                        )}
                        {archivedByHand || ownerArchived
                          ? translate('conversations.unarchive', 'Unarchive')
                          : translate('conversations.archive', 'Archive')}
                      </Button>
                    ) : null}
                    <SessionSleepMenuItem session={session} onDone={() => setMoreOpen(false)} />
                    <SessionWorkflowRecheckMenuItem
                      session={session}
                      onDone={() => setMoreOpen(false)}
                    />
                    {session.tabId ? (
                      <Button
                        variant="ghost"
                        size="xs"
                        role="menuitem"
                        aria-label={translate(
                          'conversations.closeConversation',
                          'Close conversation'
                        )}
                        className="w-full justify-start gap-2 text-destructive hover:text-destructive"
                        disabled={ledgerRefusal !== null}
                        title={ledgerRefusal ?? undefined}
                        onClick={() => {
                          setMoreOpen(false)
                          // Why: the same close as the tab's own ✕ — history kept, reopenable
                          // from Recently closed, and a running process still asks first.
                          closeTerminalTab(session.tabId!, {
                            reason: 'user',
                            captureRecentlyClosed: true
                          })
                        }}
                      >
                        <Trash2 className="size-3.5" />
                        {translate('conversations.closeConversation', 'Close conversation')}
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="xs"
                      role="menuitem"
                      aria-label={translate('conversations.history.title', 'History')}
                      className="w-full justify-start gap-2"
                      onClick={() => {
                        setMoreOpen(false)
                        useSessionHistoryOpen.getState().setOpen(key, true)
                      }}
                    >
                      <History className="size-3.5" />
                      {translate('conversations.history.title', 'History')}
                    </Button>
                  </PopoverContent>
                </Popover>
              </span>
            }
          />
          <UpNextControls subject={{ kind: 'session', session }} addDisabledReason={queueRefusal} />
        </span>
      )}
    </>
  )
}
