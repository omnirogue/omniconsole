import type { UpNextDoneBlock } from '../../../../../shared/up-next-types'
import { WhenFinished } from '../WhenFinished'
import type { UpNextController } from '../use-up-next'
import { translate as t } from '@/i18n/i18n'
import { clockLabel } from '../up-next-labels'

export function DoneBlock({
  block,
  controller
}: {
  block: UpNextDoneBlock
  controller: UpNextController
}) {
  if (block.locked) {
    return (
      <p className="text-muted-foreground">
        {block.closedAt !== undefined
          ? t('upNext.closedAt', 'closed {{time}}', {
              time: clockLabel(block.closedAt)
            })
          : block.savedAt !== undefined
            ? t('upNext.savedAt', 'saved {{time}}', {
                time: clockLabel(block.savedAt)
              })
            : t('upNext.finished', 'Done')}
      </p>
    )
  }
  return (
    <fieldset disabled={controller.disabled} className="min-w-0">
      <WhenFinished
        value={{
          finish: block.finish,
          ...(block.folderId ? { folderId: block.folderId } : {})
        }}
        onChange={(value) =>
          value.finish === 'none'
            ? void controller.remove(block.id)
            : void controller.update(block.id, {
                kind: 'done',
                finish: value.finish,
                ...(value.folderId ? { folderId: value.folderId } : {})
              })
        }
      />
    </fieldset>
  )
}
