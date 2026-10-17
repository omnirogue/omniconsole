import { SAVED_SESSIONS_FOLDER_ID } from '@/lib/session-folders'
import { getIntlLocale, translate as t } from '@/i18n/i18n'
import {
  upNextIsStoppedStage,
  type UpNextAgentTemplate,
  type UpNextBlock,
  type UpNextView
} from '../../../../shared/up-next-types'
import type { UpNextAgentIntent } from '../../../../shared/up-next-agent-intent'
import { SESSION_ACTION_PRESET_LABELS } from '../../../../shared/session-action-presets'
import { upNextSendWaits, upNextWontRun } from '../../../../shared/up-next-person-send'

export function templateLabel(template: UpNextAgentTemplate): string {
  return t(
    `upNext.template.${template}`,
    template === 'custom' ? 'Custom' : SESSION_ACTION_PRESET_LABELS[template]
  )
}
export function templateSubtitle(template: UpNextAgentTemplate): string {
  const subtitles: Partial<Record<UpNextAgentTemplate, string>> = {
    implement: 'builds toward the Outcome',
    improve: 'improves the current result',
    research: 'gathers what the next stage needs',
    plan: 'creates the plan, implements nothing',
    review: 'reports findings, changes nothing',
    critique: 'tries to break or challenge the work, reports findings',
    verify: 'checks each Done When, PASS/FAIL per item',
    judge: 'picks the winner among candidates',
    custom: 'your own instruction'
  }
  return t(`upNext.templateHelp.${template}`, subtitles[template] ?? '')
}
/** "Agent Review" / "Agent Handoff": the add buttons' words for the two agent intents. */
export function intentLabel(intent: UpNextAgentIntent): string {
  return intent === 'review'
    ? t('upNext.intent.review', 'Agent Review')
    : t('upNext.intent.handoff', 'Agent Handoff')
}
export function kindLabel(kind: UpNextBlock['kind']): string {
  const labels = { prompt: 'Prompt', agent: 'Agent', person: 'Person', done: 'Done' }
  return t(`upNext.kind.${kind}`, labels[kind])
}
/**
 * The KIND word a row prints: an agent stage says which intent it carries — REVIEW for one that
 * inspects, HANDOFF for one where the next agent acts — so the track reads the difference.
 */
export function blockKindLabel(block: UpNextBlock): string {
  if (block.kind !== 'agent') {
    return kindLabel(block.kind)
  }
  return block.intent === 'review'
    ? t('upNext.kind.review', 'Review')
    : t('upNext.kind.handoff', 'Handoff')
}
export function stateLabel(state: UpNextBlock['state']): string {
  // "needs you" is a state only a block with an OPEN REQUEST carries; a stop of any other class
  // says its own class, and none of them borrows those words.
  const labels = {
    draft: 'not queued yet',
    queued: 'queued',
    running: 'running',
    done: 'done',
    waiting: 'waiting',
    recovering: 'recovering',
    'needs-you': 'needs you',
    failed: 'failed'
  }
  return t(`upNext.state.${state}`, labels[state])
}
/** "14:31" — one HH:MM clock reading under the UI locale, for every time the panel prints. */
export function clockLabel(at: number): string {
  return new Date(at).toLocaleTimeString(getIntlLocale(), { hour: '2-digit', minute: '2-digit' })
}
export function durationLabel(ms: number): string {
  return t('upNext.minutes', '{{minutes}} min', { minutes: Math.round(ms / 60000) })
}
/**
 * Amendment 7's compact span, hour-aware, for rows, chips and the done strip ("· 3h",
 * "· 20m"). The live Now/summary line keeps amendment 14's "{{n}} min" wording through
 * `durationLabel`, so the two spellings stay where the spec put them.
 */
export function spanLabel(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60000))
  if (total < 60) {
    return t('upNext.minutesShort', '{{minutes}}m', { minutes: total })
  }
  const hours = Math.floor(total / 60)
  const minutes = total % 60
  return minutes
    ? t('upNext.hoursMinutes', '{{hours}}h {{minutes}}m', { hours, minutes })
    : t('upNext.hours', '{{hours}}h', { hours })
}
/** The drafts the primary button queues: never one composed behind a send that does not wait. */
export function queueableDrafts(view: UpNextView): UpNextBlock[] {
  return view.blocks.filter(
    (block, index) => block.state === 'draft' && !upNextWontRun(view.blocks, index)
  )
}
export function primaryLabel(view: UpNextView): string {
  const drafts = queueableDrafts(view)
  if (!drafts.length) {
    return t('upNext.upToDate', 'Up to date')
  }
  const only = drafts.length === 1 ? drafts[0] : null
  if (only?.kind === 'prompt' && only.target.kind === 'current' && only.when === 'now') {
    return t('upNext.sendNow', 'Send now')
  }
  if (only?.kind === 'person') {
    return t('upNext.send.button', 'Send')
  }
  // A lone Done on an idle session is "Finish now" (amendment 3) even when finished work is
  // still listed above it: the done strip is history, not something left to queue.
  //
  // IDLE is the Now row, not the header. The header reads the RUN — failed, waiting — for as
  // long as an outcome carries a block, including a stale one from a source refusal that has
  // since cleared, so keying the label on it made a session with nothing running, nothing queued
  // and one Done draft read "Queue 1 new block" (round-4 live sim, cli/24q_state_tree.txt: Now
  // row "NOW idle claude · waiting for you", primary button "Queue 1 new block"). The Now row is
  // the live reading of what is in flight, which is exactly what "now" in the label claims.
  if (
    only?.kind === 'done' &&
    view.now.kind === 'idle' &&
    view.blocks.every((block) => block.id === only.id || block.state === 'done')
  ) {
    return t('upNext.finishNow', 'Finish now')
  }
  if (drafts.length === 1) {
    return t('upNext.queueBlock', 'Queue 1 new block')
  }
  return t('upNext.queueBlocks', 'Queue {{count}} new blocks', { count: drafts.length })
}
export function blockTitle(block: UpNextBlock): string {
  if (block.kind === 'agent') {
    return templateLabel(block.template)
  }
  if (block.kind === 'prompt') {
    return `“${block.text}”`
  }
  if (block.kind === 'done') {
    return kindLabel('done')
  }
  return t('upNext.sendTo', 'Send to {{names}}', { names: peopleList(block.people) || '…' })
}
/** "Uma", "Uma and Gamma", "Uma, Gamma and Iris": the names a sentence reads out. */
export function peopleList(people: readonly { name: string }[]): string {
  const names = people.map((person) => person.name)
  if (names.length < 2) {
    return names[0] ?? ''
  }
  return t('upNext.names.list', '{{list}} and {{last}}', {
    list: names.slice(0, -1).join(', '),
    last: names.at(-1)!
  })
}
export function blockSecondary(
  block: UpNextBlock,
  view: UpNextView,
  folderName?: (id: string) => string | undefined
): string {
  if (block.kind === 'prompt') {
    if (block.target.kind === 'resume-after-review') {
      // Name the agent when the host can name it (amendment 2); it is idle or unknown often
      // enough that the generic sentence has to stay as the fallback.
      const agent = view.now.kind === 'current-work' ? view.now.agent : ''
      return agent
        ? t('upNext.resumePromptNamed', 'to {{agent}} when it resumes after the review', { agent })
        : t('upNext.resumePrompt', 'to the current agent when it resumes after the review')
    }
    if (block.target.kind !== 'current') {
      return ''
    }
    return block.when === 'now'
      ? view.header.state === 'running'
        ? t('upNext.nowInterrupts', 'now, interrupts')
        : t('upNext.now', 'now')
      : t('upNext.afterCurrent', 'after current work')
  }
  if (block.kind === 'done') {
    // Past tense only for what a window REPORTED done; a finished run alone closed nothing.
    if (block.closedAt !== undefined) {
      return t('upNext.closedAt', 'closed {{time}}', { time: clockLabel(block.closedAt) })
    }
    if (block.savedAt !== undefined) {
      return t('upNext.savedAt', 'saved {{time}}', { time: clockLabel(block.savedAt) })
    }
    return block.finish === 'save'
      ? t('upNext.thenSave', 'then save to {{folder}}', {
          folder:
            block.folderId === SAVED_SESSIONS_FOLDER_ID
              ? t('conversations.savedSessions', 'Saved Sessions')
              : (block.folderId && folderName?.(block.folderId)) || t('upNext.aFolder', 'a folder')
        })
      : t('upNext.thenClose', 'then close this session')
  }
  if (block.kind === 'person') {
    // A send nobody has ticked yet reads as its default, exactly as the host will commit it.
    const index = view.blocks.findIndex((item) => item.id === block.id)
    const waits =
      index === -1 ? block.relationship === 'review' : upNextSendWaits(view.blocks, index)
    if (!block.people.length) {
      return waits
        ? t('upNext.pickPeople', 'pick one or more people')
        : t('upNext.pickPerson', 'pick a person')
    }
    if (!waits) {
      return block.people.length === 1
        ? t('upNext.ownership', 'ends here — {{name}} owns it from now on', {
            name: block.people[0]!.name
          })
        : t('upNext.ownershipMany', 'ends here — {{names}} own it from now on', {
            names: peopleList(block.people)
          })
    }
    const next = view.blocks.find((item) => item.id === block.resumesAtBlockId)
    const who =
      block.people.length === 1
        ? t('upNext.reviewOne', 'continues when {{name}} replies', { name: block.people[0]!.name })
        : block.waitRule === 'any'
          ? t('upNext.reviewAnyone', 'continues when anyone replies')
          : block.people.length === 2
            ? t('upNext.reviewBoth', 'continues when both reply')
            : t('upNext.reviewAll', 'continues when all {{count}} reply', {
                count: block.people.length
              })
    return t('upNext.reviewContinuation', '{{who}} → {{next}}', {
      who,
      next: next ? `${next.number} · ${blockTitle(next)}` : t('upNext.waits', 'then waits for you')
    })
  }
  const outputs = {
    result: '',
    findings: t('upNext.findings', 'reports findings'),
    verdict: t('upNext.verdict', 'decides pass/fail on each Done When'),
    winner: t('upNext.winner', 'picks a winner')
  }
  const duration = block.progress?.durationMs ?? block.progress?.elapsedMs
  return [
    block.shape === 'solo'
      ? ''
      : t(`upNext.shape.${block.shape}`, `{{n}} · ${block.shape}`, { n: block.n }),
    outputs[block.output],
    block.promptCount
      ? block.promptCount === 1
        ? t('upNext.onePrompt', '1 prompt')
        : t('upNext.promptCount', '{{count}} prompts', { count: block.promptCount })
      : '',
    block.progress?.verdictSummary,
    // The reason a stage stopped is a sentence or two; the one-line summary carries only WHEN
    // it stopped, and the open row states the reason in full (`StageFacts`).
    stoppedLabel(block),
    duration === undefined ? '' : spanLabel(duration)
  ]
    .filter(Boolean)
    .join(' · ')
}
/** "stopped 14:31" for a stage the track stopped at; the time the host recorded, never a guess. */
export function stoppedLabel(block: UpNextBlock): string {
  if (!upNextIsStoppedStage(block)) {
    return ''
  }
  const at = block.progress?.stoppedAt
  return at === undefined
    ? t('upNext.stoppedNoTime', 'stopped')
    : t('upNext.stoppedAt', 'stopped {{time}}', { time: clockLabel(at) })
}
