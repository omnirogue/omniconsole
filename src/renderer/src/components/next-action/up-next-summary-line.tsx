import { translate as t } from '@/i18n/i18n'
import { upNextIsStoppedHeader, type UpNextView } from '../../../../shared/up-next-types'
import { durationLabel, stateLabel, templateLabel } from './up-next-labels'

export function UpNextSummaryLine({ view }: { view: UpNextView }) {
  const s = view.summary
  let text: string
  if (s.finished) {
    const f = s.finished
    text = t(
      'upNext.finishedSummary',
      '{{stages}} stages · {{executions}} executions · {{duration}} · {{met}} of {{total}} Done When',
      {
        stages: f.stages,
        executions: f.executions,
        duration: durationLabel(f.durationMs),
        met: f.doneWhenMet,
        total: f.doneWhenTotal
      }
    )
  } else if (s.live) {
    text = t(
      'upNext.liveSummary',
      'Stage {{n}} of {{total}} · {{template}} · {{done}} of {{seats}} seats done · {{duration}}',
      {
        n: s.live.stageN,
        total: s.live.stageOf,
        template: templateLabel(s.live.template),
        done: s.live.seatsDone,
        seats: s.live.seatsTotal,
        duration: durationLabel(s.live.elapsedMs)
      }
    )
  } else if (
    !view.blocks.length ||
    (upNextIsStoppedHeader(view.header.state) && !s.stages && !s.prompts && !s.people)
  ) {
    text = t('upNext.empty', 'Nothing queued.')
  } else {
    // A stopped track says so ONCE, in the header (`UpNextHeaderStatus`); down here the queue
    // behind the stop is counted and its blocks read as what they are: waiting.
    // The same pause `promptQueue.list` reports as `waitReason`; only hosts that pause set it.
    const paused = view.blocks.some(
      (block) => block.kind === 'prompt' && block.state === 'failed' && block.holdsQueue
    )
    const start = upNextIsStoppedHeader(view.header.state)
      ? stateLabel('waiting')
      : paused
        ? t('upNext.pausedBehindFailure', 'paused behind a failed prompt')
        : s.start === 'now'
          ? t('upNext.startsNow', 'starts now')
          : s.start === 'now-interrupts'
            ? t('upNext.startsInterrupts', 'starts now, interrupts')
            : s.start === 'after-stage'
              ? t('upNext.afterStage', 'after stage {{number}} finishes', {
                  number: s.afterStage ?? ''
                })
              : t('upNext.afterCurrent', 'after current work')
    text = [
      s.stages === 1
        ? t('upNext.oneStage', '1 stage')
        : s.stages
          ? t('upNext.stages', '{{count}} stages', { count: s.stages })
          : '',
      s.executions === 1
        ? t('upNext.oneExecution', '1 execution')
        : s.executions
          ? t('upNext.executions', '{{count}} executions', { count: s.executions })
          : '',
      s.prompts === 1
        ? t('upNext.onePrompt', '1 prompt')
        : s.prompts
          ? t('upNext.promptCount', '{{count}} prompts', { count: s.prompts })
          : '',
      s.people ? t('upNext.peopleCount', '{{count}} person', { count: s.people }) : '',
      s.maxConcurrency > 1
        ? t('upNext.concurrency', '{{count}} at once in stage {{stage}}', {
            count: s.maxConcurrency,
            stage: s.maxConcurrencyStage ?? ''
          })
        : '',
      start
    ]
      .filter(Boolean)
      .join(' · ')
  }
  return (
    <p
      data-up-next-summary
      className="min-w-0 text-xs text-muted-foreground"
      title={s.perStage
        .map((stage) => `${stage.number} · ${templateLabel(stage.template)}: ${stage.executions}`)
        .join(', ')}
    >
      {text}
    </p>
  )
}
