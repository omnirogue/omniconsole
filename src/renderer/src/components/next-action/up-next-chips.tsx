import { spanLabel } from './up-next-labels'
import { translate as t } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { UpNextBlock } from '../../../../shared/up-next-types'
import { upNextDueLabel } from '../../../../shared/up-next-person-due'

/**
 * One chip box for everything that sits on a row's line: option chips, the state tag and the
 * Done When toggle share a 20px height, 6px corners and a single baseline.
 */
export const CHIP_CLASS =
  'inline-flex h-5 items-center whitespace-nowrap rounded-md border px-1.5 text-[11px] leading-none'

export function UpNextChips({ block }: { block: UpNextBlock }) {
  const chips: string[] = []
  if (block.kind === 'agent') {
    const a = block.advanced
    if (a.model || a.effort) {
      chips.push([a.model, a.effort].filter(Boolean).join(' · '))
    }
    if ((a.rounds ?? 1) > 1) {
      chips.push(t('upNext.roundsChip', '↻ up to {{count}}×', { count: a.rounds! }))
    }
    if (a.endOnSuccess) {
      chips.push(t('upNext.endsOnPass', 'ends session on pass'))
    }
    if (a.readsFrom) {
      chips.push(t('upNext.readsChip', 'reads from {{blocks}}', { blocks: a.readsFrom.join(', ') }))
    }
    if (a.stopWhen) {
      chips.push(
        t('upNext.stopChip', 'stop when {{rule}}', {
          rule: t(`upNext.stopRule.${a.stopWhen}`, a.stopWhen.replaceAll('_', ' '))
        })
      )
    }
  }
  if (block.kind === 'person') {
    if (block.receive.dueAt) {
      chips.push(t('upNext.dueChip', 'due {{date}}', { date: upNextDueLabel(block.receive.dueAt) }))
    }
    // Why no transcript chip: every send carries the full conversation, so it marks nothing.
    if (block.receive.createTaskCard) {
      chips.push(t('upNext.taskChip', '+ task card'))
    }
    if (block.waiting) {
      chips.push(
        t('upNext.waitingRepliesSince', '⏸ {{replied}} of {{total}} replied · {{since}}', {
          ...block.waiting,
          since: spanLabel(block.waiting.sinceMs)
        })
      )
    }
  }
  return (
    <>
      {chips.map((chip) => (
        <span className={cn(CHIP_CLASS, 'text-muted-foreground')} key={chip}>
          {chip}
        </span>
      ))}
    </>
  )
}
