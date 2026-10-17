import { useState } from 'react'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { SessionChain } from '../../../../shared/session-chain-types'
import {
  doneWhenCountLabel,
  doneWhenFacts,
  doneWhenOpenParts,
  outcomeSentence,
  type DoneWhenFacts,
  type DoneWhenItem
} from './done-when-facts'
import { OutcomeInlineEditor } from './OutcomeInlineEditor'
import { outcomeEditDoor, type OutcomeEditDoor } from './outcome-edit'
import { useDoneWhenList } from './use-done-when-list'
import { clockLabel } from './up-next-labels'

/** Built once: the real client's commit and reload, so no render allocates a new door. */
const DEFAULT_DOOR = outcomeEditDoor()

/** ● met / ○ open, one per Done When condition, in plan order. */
function DoneWhenPips({ items }: { items: { key: string; met: boolean }[] }): React.JSX.Element {
  return (
    <span className="flex shrink-0 items-center gap-1.5" aria-hidden>
      {items.map((item) => (
        <span
          key={item.key}
          data-next-action-pip={item.met ? 'met' : 'open'}
          className={cn(
            'size-[9px] rounded-full border-[1.5px] border-status-success',
            item.met && 'bg-status-success'
          )}
        />
      ))}
    </span>
  )
}

/**
 * "· open: Sal, hat.html" — the still-open conditions by name, each carrying its identifier (the
 * employee id, the full path) in `title`. Wraps as prose; never a bare id, never overflow.
 *
 * Why `flex-1` (a zero basis): the names must never push the Details toggle onto a line of its
 * own. With a zero hypothetical size the span takes whatever the line has left and wraps inside
 * it, so pips, count, names and toggle share one line at every width.
 */
function DoneWhenOpen({ facts }: { facts: Pick<DoneWhenFacts, 'open'> }): React.JSX.Element {
  const parts = doneWhenOpenParts(facts)
  return (
    <span className="min-w-0 flex-1 break-words" data-next-action-done-when-open>
      {parts.lead}{' '}
      {parts.names.map((name, index) => (
        <span key={name.key}>
          <span title={name.detail === name.label ? undefined : name.detail}>{name.label}</span>
          {index < parts.names.length - 1 ? ', ' : ''}
        </span>
      ))}
    </span>
  )
}

/**
 * The head of the panel: what this conversation is pursuing, and how much of it is proved. The
 * sentence is one line at 16px with `edit` beside it; under it the pips, "k of n", the still-open
 * conditions by name while the list is collapsed, and ▾ to read the checklist in place.
 *
 * A conversation with no committed outcome set shows no sentence, no pips, and "Set outcome"
 * (brief 78 #1): the editor opens empty and its Save creates the set through the same commit door.
 * With no chain at all the host that mounts the line lends `startChain` — the unregistered record
 * the first commit adopts; a mount that lends none leaves the door shut and says why.
 */
export function OutcomeLine({
  chain,
  onChainChanged,
  door = DEFAULT_DOOR,
  startChain
}: {
  chain: SessionChain | null
  onChainChanged: (chain: SessionChain) => void
  /** Injectable commit/reload pair; the default is the real outcome client. */
  door?: OutcomeEditDoor
  /** Builds the chain a first outcome is committed on when there is none; null when it cannot. */
  startChain?: () => SessionChain | null
}): React.JSX.Element {
  const facts = doneWhenFacts(chain)
  const sentence = outcomeSentence(chain)
  const list = useDoneWhenList(chain?.id ?? null)
  const [editing, setEditing] = useState(false)
  // The record "Set outcome" edits while the conversation has no chain yet; dropped on close.
  const [fresh, setFresh] = useState<SessionChain | null>(null)
  const [reviewError, setReviewError] = useState<string | null>(null)
  const editable = Boolean(chain?.outcomeSet)
  const canStart = Boolean(chain) || Boolean(startChain)
  const startEditing = (): void => {
    if (!chain) {
      const built = startChain?.() ?? null
      if (!built) {
        return
      }
      setFresh(built)
    }
    setEditing(true)
  }
  const closeEditor = (): void => {
    setEditing(false)
    setFresh(null)
  }
  // A "Review" request lands here (`up-next-attention-actions.ts`): the checklist is where the
  // owner's own review condition is answered, so the request is never a dead end.
  const approveReview = async (item: DoneWhenItem): Promise<void> => {
    const set = chain?.outcomeSet
    if (!chain || !set || !item.ownReview || !door.approveReview) {
      return
    }
    setReviewError(null)
    try {
      onChainChanged(
        await door.approveReview({
          id: chain.id,
          owner: chain,
          expectedRevision: set.revision,
          outcomeId: item.outcomeId,
          conditionId: item.conditionId,
          version: item.ownReview.version
        })
      )
    } catch (cause) {
      setReviewError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  return (
    <section
      className="space-y-1 rounded-xl border border-border bg-muted/40 px-3 py-2.5"
      data-next-action-outcome
      aria-label={translate('nextAction.outcome', 'Outcome')}
    >
      {editing && (chain ?? fresh) ? (
        <OutcomeInlineEditor
          chain={(chain ?? fresh)!}
          door={door}
          onChainChanged={onChainChanged}
          onClose={closeEditor}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {translate('nextAction.outcome', 'Outcome')}
            </span>
            {/* Why no placeholder: an outcome is optional and most conversations never set one;
                "Set outcome" beside the label is the whole empty state. */}
            {sentence ? (
              <span
                className="min-w-0 flex-1 text-base font-medium"
                data-next-action-outcome-sentence
              >
                {sentence}
              </span>
            ) : null}
            {editable ? (
              <Button
                type="button"
                variant="link"
                size="xs"
                className="h-auto px-0 text-xs text-muted-foreground"
                onClick={() => setEditing(true)}
              >
                {chain?.outcomeSet?.outcomes.some((outcome) => outcome.actions.length > 0)
                  ? translate('nextAction.editNextActions', 'Edit next actions')
                  : translate('nextAction.editOutcome', 'edit')}
              </Button>
            ) : (
              <Button
                type="button"
                variant="link"
                size="xs"
                className="h-auto px-0 text-xs"
                data-next-action-set-outcome
                disabled={!canStart}
                title={
                  canStart
                    ? undefined
                    : translate(
                        'nextAction.setOutcomeUnavailable',
                        'Set an outcome by queueing a block first.'
                      )
                }
                onClick={startEditing}
              >
                {translate('nextAction.setOutcome', 'Set outcome')}
              </Button>
            )}
          </div>
          {facts.total > 0 ? (
            <div
              className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground"
              data-next-action-done-when
            >
              <DoneWhenPips items={facts.items} />
              <span className="shrink-0" data-next-action-done-when-count>
                {doneWhenCountLabel(facts)}
              </span>
              {facts.open.length > 0 && !list.expanded ? <DoneWhenOpen facts={facts} /> : null}
              {/* The accessible name starts with the visible "Details" (WCAG 2.5.3); `ml-auto`
                  keeps the toggle at the right edge once the open names beside it unmount. */}
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="ml-auto h-5 shrink-0 gap-0.5 px-1 text-xs text-muted-foreground"
                aria-expanded={list.expanded}
                aria-label={`${translate('nextAction.doneWhenDetails', 'Details')} — ${translate(
                  'nextAction.doneWhenToggle',
                  'Done when conditions'
                )}`}
                onClick={list.toggle}
              >
                {translate('nextAction.doneWhenDetails', 'Details')}
                <span aria-hidden>{list.expanded ? '▴' : '▾'}</span>
              </Button>
            </div>
          ) : null}
          {list.expanded && facts.total > 0 ? (
            <ul
              className="mt-1 space-y-0.5 border-t border-dashed border-border pt-1.5 text-xs"
              data-next-action-done-when-list
            >
              {facts.items.map((item) => (
                <li
                  key={item.key}
                  title={item.detail}
                  className={cn('min-w-0 break-words', !item.met && 'text-muted-foreground')}
                  data-next-action-condition={item.met ? 'met' : 'open'}
                >
                  <span>{`${item.met ? '✓' : '○'} ${item.label}`}</span>
                  {item.ownReview && door.approveReview && (
                    <Button
                      type="button"
                      size="xs"
                      variant="secondary"
                      className="ml-2"
                      data-next-action-approve-review={item.conditionId}
                      onClick={() => void approveReview(item)}
                    >
                      {translate('nextStep.approveReview', 'Approve review')}
                    </Button>
                  )}
                  {item.met && item.receipt !== undefined && item.verifiedAt !== undefined && (
                    <p className="pl-3 text-muted-foreground">
                      {item.receipt} ·{' '}
                      <time dateTime={new Date(item.verifiedAt).toISOString()}>
                        {clockLabel(item.verifiedAt)}
                      </time>
                    </p>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
          {reviewError && (
            <p role="alert" className="min-w-0 break-words text-xs text-destructive">
              {reviewError}
            </p>
          )}
        </>
      )}
    </section>
  )
}
