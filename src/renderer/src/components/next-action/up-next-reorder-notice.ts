import { translate as t } from '@/i18n/i18n'
import { upNextTargetOf } from '../../../../shared/up-next-order'
import type { UpNextBlock, UpNextView } from '../../../../shared/up-next-types'
import { blockTitle } from './up-next-labels'

export type MovedPrompt = { id: string; previousTarget: string }
export function reorderTarget(view: UpNextView, block: UpNextBlock): string {
  return JSON.stringify(upNextTargetOf(view.blocks, view.blocks.indexOf(block)))
}
export function reorderNotice(
  view: UpNextView,
  block: UpNextBlock,
  moved: MovedPrompt | null
): string | null {
  if (
    block.kind !== 'prompt' ||
    moved?.id !== block.id ||
    moved.previousTarget === reorderTarget(view, block)
  ) {
    return null
  }
  const target = upNextTargetOf(view.blocks, view.blocks.indexOf(block))
  if (target.kind === 'current') {
    return t('upNext.movedCurrent', 'now to the current agent')
  }
  if (target.kind === 'resume-after-review') {
    return t('upNext.movedReview', 'now after the review')
  }
  const parent = view.blocks.find((item) => item.id === target.blockId)
  return parent
    ? t('upNext.movedStage', 'now under {{number}} · {{template}}', {
        number: parent.number,
        template: blockTitle(parent)
      })
    : null
}
