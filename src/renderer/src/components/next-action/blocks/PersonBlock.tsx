import { useId, useState } from 'react'
import { translate as t } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { PersonDueField } from '../PersonDueField'
import { PersonReviewPageField } from './PersonReviewPageField'
import { artifactReviewThreadTitle } from '../../../../../shared/handoff-artifact-review'
import { useHandoffPeople } from '@/components/next-step/use-handoff-people'
import { RecipientAvatar, recipientPhoto } from '@/components/next-step/recipient-avatar'
import { searchRoster } from '../../../../../shared/team-roster-search'
import { upNextDueLabel } from '../../../../../shared/up-next-person-due'
import {
  upNextSendWaits,
  upNextStepsAfter,
  upNextStepsPausedBy
} from '../../../../../shared/up-next-person-send'
import {
  UP_NEXT_BLOCK_ID,
  UP_NEXT_MAX_PEOPLE,
  type UpNextBlockPatch,
  type UpNextDraftPerson,
  type UpNextPersonBlock,
  type UpNextPersonReceive,
  type UpNextView
} from '../../../../../shared/up-next-types'
import type { UpNextController } from '../use-up-next'
import { peopleList } from '../up-next-labels'
import { sendConsequence } from '../up-next-person-lines'

type SendPatch = Omit<Extract<UpNextBlockPatch, { kind: 'person' }>, 'kind' | 'receive'>

/** Still the person's to change: composed, or held behind an earlier review and not launched. */
function composing(block: UpNextPersonBlock): boolean {
  return !block.locked && (block.state === 'draft' || block.id.startsWith(UP_NEXT_BLOCK_ID.draft))
}

/** To: one or several people from the roster, shown as chips. */
function SendTo({
  block,
  onPeople
}: {
  block: UpNextPersonBlock
  onPeople: (people: UpNextDraftPerson[]) => void
}) {
  const { people, reload } = useHandoffPeople()
  const [query, setQuery] = useState('')
  const rows = people.phase === 'ready' ? searchRoster(people.value, query, 12).people : []
  const chosen = block.people.map(({ id, name }) => ({ id, name }))
  const label = t('upNext.send.addPerson', 'Add a person…')
  return (
    <div className="space-y-2" role="group" aria-label={t('upNext.send.to', 'To')}>
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        <span className="w-10 shrink-0 text-xs font-medium">{t('upNext.send.to', 'To')}</span>
        {block.people.map((person) => (
          <Button
            size="xs"
            variant="outline"
            key={person.id}
            aria-label={t('upNext.send.removePerson', 'Remove {{name}}', { name: person.name })}
            onClick={() => onPeople(chosen.filter((item) => item.id !== person.id))}
          >
            <RecipientAvatar name={person.name} photoUrl={person.photoUrl} />
            {person.name} ×
          </Button>
        ))}
      </div>
      <Input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        aria-label={label}
        placeholder={label}
      />
      {people.phase === 'error' && <p role="alert">{people.message}</p>}
      {people.phase === 'loading' && <p>{t('upNext.loadingPeople', 'Loading people…')}</p>}
      <div className="max-h-48 overflow-y-auto scrollbar-sleek">
        {rows.map((person) => (
          <Button
            className="flex w-full justify-start"
            variant="ghost"
            size="sm"
            key={person.id}
            disabled={
              chosen.some((item) => item.id === person.id) || chosen.length >= UP_NEXT_MAX_PEOPLE
            }
            onClick={() => onPeople([...chosen, { id: person.id, name: person.name }])}
          >
            <RecipientAvatar name={person.name} photoUrl={recipientPhoto(person, [])} />
            {person.name}
          </Button>
        ))}
      </div>
      <Button size="xs" variant="ghost" onClick={reload}>
        {t('upNext.refreshPeople', 'Refresh people')}
      </Button>
    </div>
  )
}

/**
 * SEND TO A PERSON: To, Note, Due, and the one choice — wait for their OK or not — with the
 * sentence that says what that choice does. Every save writes "sends everything", so an older
 * draft that stored less is brought up to it the first time it is touched here.
 */
function SendForm({
  block,
  view,
  controller
}: {
  block: UpNextPersonBlock
  view: UpNextView
  controller: UpNextController
}) {
  const id = useId()
  const index = view.blocks.findIndex((entry) => entry.id === block.id)
  const blocks = index === -1 ? [block] : view.blocks
  const at = Math.max(index, 0)
  const waits = upNextSendWaits(blocks, at)
  const save = (patch: SendPatch, receive: UpNextPersonReceive = block.receive) =>
    void controller.update(block.id, {
      kind: 'person',
      ...patch,
      receive: { ...receive, files: true, transcript: true }
    })
  return (
    <fieldset disabled={controller.disabled} className="min-w-0 space-y-3" data-person-send>
      <legend className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {t('upNext.send.heading', 'Send to a person')}
      </legend>
      <SendTo block={block} onPeople={(people) => save({ people })} />
      <div className="space-y-1">
        <Label htmlFor={`${id}-note`} className="text-xs">
          {t('upNext.note', 'Note')}
        </Label>
        <Textarea
          id={`${id}-note`}
          key={block.receive.note ?? ''}
          defaultValue={block.receive.note}
          placeholder={t('upNext.send.notePlaceholder', 'What I need from you…')}
          onBlur={(event) => {
            if (event.target.value !== (block.receive.note ?? '')) {
              save({}, { ...block.receive, note: event.target.value })
            }
          }}
        />
      </div>
      <PersonDueField
        key={block.receive.dueAt ?? ''}
        value={block.receive.dueAt}
        onChange={(dueAt) => {
          const { dueAt: _previous, ...receive } = block.receive
          save({}, dueAt ? { ...receive, dueAt } : receive)
        }}
      />
      <PersonReviewPageField
        value={block.receive.artifact}
        onChange={(artifact) => {
          const { artifact: _previous, ...receive } = block.receive
          save({}, artifact ? { ...receive, artifact } : receive)
        }}
      />
      <div className="space-y-1">
        <div className="flex items-start gap-2">
          <Checkbox
            id={`${id}-wait`}
            className="mt-0.5"
            checked={waits}
            aria-describedby={`${id}-consequence`}
            // Why only here: the choice is stored when the person touches it, never by itself.
            onCheckedChange={(checked) =>
              save({ relationship: checked === true ? 'review' : 'handoff' })
            }
          />
          <Label htmlFor={`${id}-wait`} className="text-xs font-normal leading-snug">
            {t('upNext.send.wait', 'Wait for their OK before my next steps run')}
          </Label>
        </div>
        <p
          id={`${id}-consequence`}
          aria-live="polite"
          className="pl-6 text-xs font-medium"
          data-person-send-consequence
        >
          {sendConsequence(
            block.people,
            waits,
            waits ? upNextStepsPausedBy(blocks, at) : upNextStepsAfter(blocks, at)
          )}
        </p>
      </div>
      <p className="text-[11px] text-muted-foreground" data-person-send-everything>
        {/* Why the host decides: an SSH, WSL or remote pane's conversation cannot be read here. */}
        {view.sendsConversation === false
          ? t(
              'upNext.send.everythingButConversation',
              "Sends files · summary. The conversation can't be included from here."
            )
          : t('upNext.send.everything', 'Sends everything: files · summary · full conversation')}
      </p>
    </fieldset>
  )
}

/** A send that has left the composer: what went, to whom. Its status line sits on the row. */
function SentFacts({ block }: { block: UpNextPersonBlock }) {
  return (
    <div className="min-w-0 space-y-1 break-words text-muted-foreground">
      <p>{t('upNext.send.toNames', 'To: {{names}}', { names: peopleList(block.people) })}</p>
      {block.receive.artifact && <p>{artifactReviewThreadTitle(block.receive.artifact)}</p>}
      {block.receive.note && <p className="whitespace-pre-wrap">{block.receive.note}</p>}
      {block.receive.dueAt && (
        <p>{t('upNext.dueChip', 'due {{date}}', { date: upNextDueLabel(block.receive.dueAt) })}</p>
      )}
    </div>
  )
}

export function PersonBlock({
  block,
  view,
  controller
}: {
  block: UpNextPersonBlock
  view: UpNextView
  controller: UpNextController
}) {
  return composing(block) ? (
    <SendForm block={block} view={view} controller={controller} />
  ) : (
    <SentFacts block={block} />
  )
}
