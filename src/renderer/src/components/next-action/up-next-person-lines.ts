import { translate as t } from '@/i18n/i18n'
import type { UpNextPerson, UpNextPersonBlock, UpNextView } from '../../../../shared/up-next-types'
import { clockLabel, peopleList } from './up-next-labels'

type Named = Pick<UpNextPerson, 'name'>

/** A note longer than this is cut in the status line; the whole note stays in its tooltip. */
const NOTE_PREVIEW_CHARS = 120

/** Until when the steps wait: one person's OK, both of two, or all of several. */
function untilOk(people: readonly Named[]): string {
  if (people.length === 1) {
    return t('upNext.send.untilOne', 'until {{name}} says OK', { name: people[0]!.name })
  }
  if (people.length === 2) {
    return t('upNext.send.untilBoth', 'until {{first}} and {{second}} both say OK', {
      first: people[0]!.name,
      second: people[1]!.name
    })
  }
  return people.length
    ? t('upNext.send.untilAll', 'until all {{count}} say OK', { count: people.length })
    : t('upNext.send.untilThem', 'until they say OK')
}

/**
 * The sentence under "Wait for their OK": what the tick DOES, so a person can predict it. `steps`
 * is how many of the blocks after the send it can hold (`upNextStepsAfter`).
 */
export function sendConsequence(people: readonly Named[], waits: boolean, steps: number): string {
  if (waits) {
    if (!steps) {
      return t(
        'upNext.send.nothingAfter',
        "Nothing else runs after this; you'll see their answer here."
      )
    }
    return steps === 1
      ? t('upNext.send.pauseOne', 'Your next step will PAUSE {{until}}.', {
          until: untilOk(people)
        })
      : t('upNext.send.pauseMany', 'Your {{count}} next steps will PAUSE {{until}}.', {
          count: steps,
          until: untilOk(people)
        })
  }
  const becomes = people.length
    ? t('upNext.send.becomes', "It becomes {{names}}'s.", { names: peopleList(people) })
    : t('upNext.send.becomesTheirs', 'It becomes theirs.')
  if (!steps) {
    return becomes
  }
  return `${becomes} ${
    steps === 1
      ? t('upNext.send.wontRunOne', "Your next step won't run.")
      : t('upNext.send.wontRunMany', "Your next steps won't run.")
  }`
}

export type SendStatus = {
  kind:
    | 'failed'
    | 'part-sent'
    | 'pending'
    | 'sending'
    | 'sent'
    | 'waiting'
    | 'partial'
    | 'approved'
    | 'changes'
    | 'fixing'
    | 'asked-again'
  text: string
  /** The whole reviewer note when the line had to cut it. */
  title?: string
}

/** "Waiting for Uma's OK." / "… Uma and Gamma to say OK." / "… all 3 to say OK." */
function waitingFor(people: readonly Named[]): string {
  if (people.length === 2) {
    return t('upNext.sendStatus.waitingBoth', 'Waiting for {{first}} and {{second}} to say OK.', {
      first: people[0]!.name,
      second: people[1]!.name
    })
  }
  return people.length > 2
    ? t('upNext.sendStatus.waitingAll', 'Waiting for all {{count}} to say OK.', {
        count: people.length
      })
    : t('upNext.sendStatus.waitingOne', "Waiting for {{name}}'s OK.", {
        name: people[0]?.name ?? ''
      })
}

/** A reviewer asked for changes on this round: who, and what they wrote. */
function changesLine(block: UpNextPersonBlock, paused: string): SendStatus | null {
  const waiting = block.waiting
  const asked = waiting?.answers?.find((answer) => answer.decision === 'request_changes')
  if (!waiting || !asked) {
    return null
  }
  const round = waiting.round ?? 1
  const note = waiting.changes?.findLast(
    (change) => change.employeeId === asked.employeeId && change.round === round
  )?.note
  const cut =
    note && note.length > NOTE_PREVIEW_CHARS ? `${note.slice(0, NOTE_PREVIEW_CHARS)}…` : note
  const said = cut
    ? t('upNext.sendStatus.changes', "{{name}} wants changes: '{{note}}'.", {
        name: asked.name,
        note: cut
      })
    : t('upNext.sendStatus.changesNoNote', '{{name}} wants changes.', { name: asked.name })
  return {
    kind: 'changes',
    text: [said, paused].filter(Boolean).join(' '),
    ...(cut !== note ? { title: note } : {})
  }
}

/**
 * Released work is running: a block after the send is queued or running on its own, not a draft
 * and not still held (a release the host refused leaves it held, and a later draft never ran).
 */
function stepsReleased(block: UpNextPersonBlock, view: UpNextView): boolean {
  const index = view.blocks.findIndex((entry) => entry.id === block.id)
  return (
    index !== -1 &&
    view.blocks
      .slice(index + 1)
      .some((entry) => (entry.state === 'queued' || entry.state === 'running') && !entry.heldFor)
  )
}

/** Where a review stands once it is out, from the host's `UpNextReviewWaiting` facts. */
function reviewLine(block: UpNextPersonBlock, view: UpNextView): SendStatus {
  const names = peopleList(block.people)
  if (block.state === 'done') {
    return {
      kind: 'approved',
      text: stepsReleased(block, view)
        ? t('upNext.sendStatus.approvedRunning', '{{names}} said OK. Your steps are running now.', {
            names
          })
        : t('upNext.sendStatus.approved', '{{names}} said OK.', { names })
    }
  }
  const held = view.blocks.filter((entry) => entry.heldFor?.blockId === block.id).length
  const paused = held ? t('upNext.sendStatus.stillPaused', 'Steps still paused.') : ''
  const waiting = block.waiting
  if (waiting?.fixing) {
    return {
      kind: 'fixing',
      text: t('upNext.sendStatus.fixing', 'Your agent is making the changes.')
    }
  }
  const changes = changesLine(block, paused)
  if (changes) {
    return changes
  }
  if (waiting?.approved && waiting.approved < waiting.total) {
    return {
      kind: 'partial',
      text: t('upNext.sendStatus.partial', '{{approved}} of {{total}} said OK.', {
        approved: waiting.approved,
        total: waiting.total
      })
    }
  }
  if ((waiting?.round ?? 1) > 1) {
    return {
      kind: 'asked-again',
      text: t('upNext.sendStatus.askedAgain', 'Asked {{names}} again (round {{round}}).', {
        names,
        round: waiting!.round!
      })
    }
  }
  const count = held
    ? held === 1
      ? t('upNext.sendStatus.pausedOne', '1 step paused.')
      : t('upNext.sendStatus.pausedMany', '{{count}} steps paused.', { count: held })
    : ''
  return { kind: 'waiting', text: [waitingFor(block.people), count].filter(Boolean).join(' ') }
}

/**
 * A send that did not go out. "Nothing changed" is true only when nobody received it: delivery
 * goes one person at a time, so those it already reached are named, and so are those it missed.
 */
function undelivered(block: UpNextPersonBlock): SendStatus {
  const reached = new Set(block.reachedIds ?? [])
  const sent = block.people.filter((person) => reached.has(person.id))
  if (!sent.length) {
    return { kind: 'failed', text: t('upNext.sendStatus.failed', "Didn't send. Nothing changed.") }
  }
  const missed = block.people.filter((person) => !reached.has(person.id))
  // Why: every named person got it and what failed after them (an agent) has no name here.
  if (!missed.length) {
    return {
      kind: 'part-sent',
      text: t('upNext.sendStatus.restFailed', "Sent to {{sent}}. The rest didn't go out.", {
        sent: peopleList(sent)
      })
    }
  }
  return {
    kind: 'part-sent',
    text: t('upNext.sendStatus.partSent', "Sent to {{sent}}. Didn't reach {{missed}}.", {
      sent: peopleList(sent),
      missed: peopleList(missed)
    })
  }
}

/**
 * The one line under a send once it has left the composer, read only from host facts: the block's
 * committed and delivery state, and what its review has heard back. Null while it is composed.
 */
export function sendStatus(block: UpNextPersonBlock, view: UpNextView): SendStatus | null {
  if (block.state === 'draft' || block.heldFor) {
    return null
  }
  if (block.sendFailure) {
    return undelivered(block)
  }
  if (block.state === 'queued') {
    return {
      kind: 'pending',
      text: t('upNext.sendStatus.pending', 'Sends when the work before it is done.')
    }
  }
  if (block.state === 'running') {
    return { kind: 'sending', text: t('upNext.sendStatus.sending', 'Sending…') }
  }
  if (block.relationship === 'handoff') {
    const names = peopleList(block.people)
    return {
      kind: 'sent',
      text:
        block.sentAt === undefined
          ? t('upNext.sendStatus.sentNoTime', 'Sent to {{names}}. Nothing is waiting.', { names })
          : t('upNext.sendStatus.sent', 'Sent to {{names}} {{time}}. Nothing is waiting.', {
              names,
              time: clockLabel(block.sentAt)
            })
    }
  }
  return reviewLine(block, view)
}
