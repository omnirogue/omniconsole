import { WhenFinished } from './WhenFinished'
import { whenFinishedFrom, sessionFinishActionFrom } from './when-finished-value'
import { upNextWithoutFinishBlock } from './up-next-without-finish-block'
import { useUpNextAddDisclosure } from './use-up-next-add-disclosure'
import { upNextSurface } from './up-next-surface'
import { UpNextOutcomeContext } from './up-next-outcome-context'
import { useDoneWhenList } from './use-done-when-list'
import { reorderNotice, reorderTarget, type MovedPrompt } from './up-next-reorder-notice'
import { Plus } from 'lucide-react'
import { useContext, useEffect, useRef, useState, useMemo } from 'react'
import { useSessionFolders } from '@/store/session-folders'
import { translate as t } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { UpNextSurface } from './up-next-commit'
import type { SessionOutcomeRuntimeTarget } from '../../../../shared/session-outcome-routing'
import { upNextIsEndCap } from '../../../../shared/up-next-order'
import { upNextSendWaits, upNextWontRun } from '../../../../shared/up-next-person-send'
import { PersonSendStatus } from './PersonSendStatus'
import { UpNextQueuedPromptFailure } from './UpNextQueuedPromptFailure'
import {
  upNextIsFinished,
  type UpNextConversationId,
  type UpNextBlock
} from '../../../../shared/up-next-types'
import { useUpNext, type UpNextController } from './use-up-next'
import { UpNextRow } from './up-next-row'
import { NowRow } from './NowRow'
import { AddBlockBar } from './AddBlockBar'
import { UP_NEXT_COMPOSER_ENABLED } from './up-next-composer-flag'
import { blockTitle, blockSecondary } from './up-next-labels'
import { CHIP_CLASS, UpNextChips } from './up-next-chips'
import { UpNextChainFooter } from './up-next-chain-footer'
import { UpNextChainHeading } from './up-next-chain-heading'
import { BlockDetail } from './up-next-block-detail'
import { RAIL_TRACK_CLASS } from './up-next-rail'
import { DoneStrip, EmptySlot, TrackEnd } from './up-next-track-rows'
import { focusConversationInput, focusFirstBlockField } from './up-next-focus'
import { idleEmpty, rowMoveDisabled, stopKey, stoppedNowId } from './up-next-chain-rules'

export type UpNextChainProps = {
  source: UpNextConversationId | null
  surface?: UpNextSurface
  owner?: SessionOutcomeRuntimeTarget
  onChanged?: () => void
  compactAdd?: boolean
}
const LOCAL_OWNER: SessionOutcomeRuntimeTarget = { kind: 'local' }
export function UpNextChain({
  source,
  surface,
  owner = LOCAL_OWNER,
  onChanged,
  compactAdd = false
}: UpNextChainProps) {
  const ownerKey = JSON.stringify(owner)
  const defaultSurface = useMemo(
    () => upNextSurface(undefined, JSON.parse(ownerKey) as SessionOutcomeRuntimeTarget),
    [ownerKey]
  )
  const controller = useUpNext(source, undefined, surface ?? defaultSurface, owner)
  return (
    <UpNextChainView
      compactAdd={compactAdd}
      controller={{
        ...controller,
        commit: async () => {
          const committed = await controller.commit()
          if (committed) {
            onChanged?.()
          }
          return committed
        }
      }}
    />
  )
}

export function UpNextChainView({
  controller,
  compactAdd = false
}: {
  controller: UpNextController
  compactAdd?: boolean
}) {
  const folders = useSessionFolders((state) => state.metadata.folders)
  const rawView = controller.view
  const view = rawView ? upNextWithoutFinishBlock(rawView) : null
  const legacyFinish = rawView?.blocks.find((block) => block.kind === 'done')
  const finish = controller.whenFinished
    ? whenFinishedFrom(controller.whenFinished)
    : legacyFinish?.kind === 'done'
      ? { finish: legacyFinish.finish, folderId: legacyFinish.folderId }
      : whenFinishedFrom(null)
  const chainId = useContext(UpNextOutcomeContext)
  const doneWhen = useDoneWhenList(chainId)
  const add = useUpNextAddDisclosure(compactAdd)
  const [opened, setOpened] = useState<string | null>(null)
  const [doneOpen, setDoneOpen] = useState(false)
  const [beforeAdd, setBeforeAdd] = useState<string[] | null>(null)
  const [moved, setMoved] = useState<MovedPrompt | null>(null)
  // The stopped stage opens by itself so its reason is read without a click (amendment 7);
  // folding it is remembered per STOP (`stopKey`), so a new stop of the same stage opens again.
  const [foldedStop, setFoldedStop] = useState<string | null>(null)
  // A finished run reads the same whether or not its session was also closed: history, no add bar.
  const closed = view ? upNextIsFinished(view.header.state) : false
  const blockedNow = stoppedNowId(view)
  const quiet = view ? idleEmpty(view) : false
  // Blocks composed behind a send that does not wait sit below where the track ends.
  const stranded = (block: UpNextBlock): boolean =>
    Boolean(view && upNextWontRun(view.blocks, view.blocks.indexOf(block)))
  const section = useRef<HTMLElement>(null)
  // Keyboard loop (brief 78 #8): an add opens the new block and puts the caret in its first
  // field once that row is on screen; a commit hands focus back to the conversation's input.
  const focusAdded = useRef(false)
  useEffect(() => {
    if (!focusAdded.current || !view || beforeAdd === null) {
      return
    }
    const added = view.blocks.find((block) => !beforeAdd.includes(block.id))
    if (added) {
      focusAdded.current = false
      focusFirstBlockField(section.current, added.id)
    }
  }, [view, beforeAdd])
  const commit = async (): Promise<boolean> => {
    const committed = await controller.commit()
    if (committed) {
      focusConversationInput(section.current)
    }
    return committed
  }
  const renderRow = (block: UpNextBlock, now = false) => {
    if (!view) {
      return null
    }
    const index = view.blocks.indexOf(block)
    const notice = reorderNotice(view, block, moved)
    const autoOpen = block.id === blockedNow && foldedStop !== stopKey(block)
    const open =
      opened === block.id || autoOpen || (beforeAdd !== null && !beforeAdd.includes(block.id))
    const disabledMoves = rowMoveDisabled(view, block, index)
    return (
      <UpNextRow
        key={block.id}
        block={block}
        now={now}
        wontRun={stranded(block)}
        status={
          block.kind === 'person' ? (
            <PersonSendStatus block={block} view={view} />
          ) : (
            <UpNextQueuedPromptFailure block={block} controller={controller} />
          )
        }
        moved={notice !== null}
        title={blockTitle(block)}
        secondary={blockSecondary(
          block,
          view,
          (id) => folders.find((folder) => folder.id === id)?.name
        )}
        chips={
          <>
            <UpNextChips block={block} />
            {block.kind === 'agent' && block.output === 'verdict' && chainId && (
              <Button
                size="xs"
                variant="ghost"
                className={cn(CHIP_CLASS, 'gap-0.5 text-muted-foreground')}
                aria-label={t('nextAction.doneWhenToggle', 'Done when conditions')}
                onClick={doneWhen.toggle}
                aria-expanded={doneWhen.expanded}
              >
                {t('nextAction.doneWhenLink', 'Done When')}
                <span aria-hidden>{doneWhen.expanded ? '▴' : '▾'}</span>
              </Button>
            )}
            {notice && (
              <span
                role="status"
                className="text-xs text-status-info motion-safe:animate-pulse [animation-iteration-count:1]"
              >
                {notice}
              </span>
            )}
          </>
        }
        open={open}
        onOpen={() => {
          setBeforeAdd(null)
          setMoved(null)
          if (block.id === blockedNow) {
            // Folding the stopped stage must not close a row the person opened beside it.
            setFoldedStop(open ? stopKey(block) : null)
            setOpened((current) => (current === block.id ? null : current))
            return
          }
          setOpened(open ? null : block.id)
        }}
        onMove={async (direction) => {
          const previousTarget = reorderTarget(view, block)
          if (await controller.reorder(block.id, direction)) {
            setMoved({ id: block.id, previousTarget })
          }
        }}
        onRemove={() => void controller.remove(block.id)}
        // A finished run is history, except what never ran from it: still the person's to drop.
        disabled={controller.disabled || (closed && !stranded(block))}
        upDisabled={disabledMoves.up}
        downDisabled={disabledMoves.down}
      >
        <BlockDetail
          block={block}
          view={view}
          controller={{
            ...controller,
            configureAfter: async (id) => {
              const applied = await controller.configureAfter(id)
              if (applied) {
                setOpened(null)
                setBeforeAdd(view.blocks.map((item) => item.id))
              }
              return applied
            }
          }}
        />
      </UpNextRow>
    )
  }
  // Finished stages fold away; a send that came back keeps its status line in view.
  const done = view?.blocks.filter((block) => block.state === 'done' && block.kind !== 'person')
  const answered = view?.blocks.filter((block) => block.state === 'done' && block.kind === 'person')
  const nowId = view?.now.kind === 'stage' ? view.now.blockId : null
  const now = view?.blocks.find((block) => block.id === nowId)
  const shown = view?.blocks.filter(
    (block) => closed || (block.state !== 'done' && block.id !== nowId)
  )
  const last = view?.blocks.findLast((block) => !stranded(block))
  const capped = Boolean(
    view &&
    last &&
    (upNextIsEndCap(last) ||
      (last.kind === 'person' && !upNextSendWaits(view.blocks, view.blocks.indexOf(last))))
  )
  const heading = (
    <UpNextChainHeading
      view={view}
      chainId={chainId}
      focusComposer={add.focus}
      onOpenBlock={(id) => {
        setBeforeAdd(null)
        if (view?.blocks.find((block) => block.id === id)?.state === 'done') {
          setDoneOpen(true)
        }
        setOpened(id)
      }}
    />
  )
  return (
    <section
      ref={section}
      className="min-w-0 space-y-3 p-3"
      data-up-next-chain
      aria-label={t('upNext.title', 'Up next')}
    >
      {controller.error && (
        <p role="alert" className="min-w-0 break-words text-xs text-destructive">
          {controller.error}
        </p>
      )}
      {!view ? (
        <>
          {heading}
          <p role="status" className="text-xs text-muted-foreground">
            {controller.disabled
              ? t('upNext.noConversation', 'Open a conversation to configure Up next.')
              : t('upNext.loading', 'Loading Up next…')}
          </p>
        </>
      ) : (
        <>
          {!closed && UP_NEXT_COMPOSER_ENABLED && compactAdd && (
            <Button
              type="button"
              size="xs"
              variant="outline"
              className="ml-auto flex gap-1"
              aria-expanded={add.open}
              aria-controls={add.id}
              data-up-next-add-toggle
              onClick={() => add.setOpen(!add.open)}
            >
              <Plus className="size-3" aria-hidden />
              {t('common.add', 'Add')}
            </Button>
          )}
          {/* Now first, then the heading ON the rail, then what is queued: the one line joins them. */}
          <div className={cn(RAIL_TRACK_CLASS, 'min-w-0 space-y-1.5')} data-up-next-track>
            {!closed && done?.length ? (
              <DoneStrip done={done} open={doneOpen} onToggle={() => setDoneOpen(!doneOpen)}>
                {done.map((block) => renderRow(block))}
              </DoneStrip>
            ) : null}
            {!closed && answered?.map((block) => renderRow(block))}
            {!closed && (now ? renderRow(now, true) : <NowRow view={view} quiet={quiet} />)}
            {heading}
            {!closed && !view.blocks.length && <EmptySlot />}
            {shown?.filter((block) => !stranded(block)).map((block) => renderRow(block))}
            <TrackEnd
              capped={capped}
              closed={closed}
              quiet={quiet}
              hideWait={finish.finish !== 'none'}
            />
            {shown?.filter(stranded).map((block) => renderRow(block))}
          </div>
          {!closed && UP_NEXT_COMPOSER_ENABLED && (
            <div id={add.id} hidden={compactAdd && !add.open}>
              <AddBlockBar
                ref={add.ref}
                view={view}
                controller={controller}
                onAdded={() => {
                  add.setOpen(false)
                  setOpened(null)
                  setBeforeAdd(view.blocks.map((item) => item.id))
                  focusAdded.current = true
                }}
              />
            </div>
          )}
          {!closed && (
            <WhenFinished
              value={finish}
              disabled={controller.disabled || !controller.setWhenFinished}
              onChange={(value) => {
                const action = sessionFinishActionFrom(value)
                void controller.setWhenFinished?.(
                  value.finish === 'none'
                    ? null
                    : {
                        action: action.action,
                        ...(action.folderId ? { folderId: action.folderId } : {})
                      }
                )
              }}
            />
          )}
          <UpNextChainFooter view={view} controller={{ ...controller, commit }} closed={closed} />
        </>
      )}
    </section>
  )
}
