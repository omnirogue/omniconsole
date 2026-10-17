import { toast } from 'sonner'
import { Fragment } from 'react'
import { Copy } from 'lucide-react'
import { useSessionFolders } from '@/store/session-folders'
import { translate as t } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { upNextNotation } from '../../../../shared/up-next-summary'
import { upNextNumber } from '../../../../shared/up-next-order'
import { upNextIsStoppedStage, type UpNextView } from '../../../../shared/up-next-types'
import { blockTitle, blockSecondary } from './up-next-labels'

export function Notation({ view, onOpen }: { view: UpNextView; onOpen: (id: string) => void }) {
  const folders = useSessionFolders((state) => state.metadata.folders)
  const text = upNextNotation(view)
  if (!text) {
    return null
  }
  const parents = upNextNumber(view.blocks).parentIds
  const segments = view.blocks.flatMap((block, index) => {
    if (block.kind === 'prompt' && parents[index]) {
      return []
    }
    const children = view.blocks.filter((_, i) => parents[i] === block.id)
    return [
      {
        id: block.id,
        text: upNextNotation({ ...view, blocks: [block, ...children], now: { kind: 'idle' } }),
        title: [
          blockTitle(block),
          blockSecondary(block, view, (id) => folders.find((folder) => folder.id === id)?.name)
        ]
          .filter(Boolean)
          .join(' · ')
      }
    ]
  })
  if (
    !view.blocks.some((block) => block.state === 'running' || upNextIsStoppedStage(block)) &&
    view.now.kind === 'current-work'
  ) {
    segments.unshift({
      id: '',
      text: `● ${view.now.label}`.trimEnd(),
      title: t('upNext.currentWork', 'Current work')
    })
  }
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs font-mono">
      <span data-up-next-notation>
        {segments.map((segment, index) => (
          <Fragment key={segment.id}>
            {index > 0 && ' → '}
            {segment.id ? (
              <button
                type="button"
                title={segment.title}
                className="border-b border-dotted"
                onClick={() => onOpen(segment.id)}
              >
                {segment.text}
              </button>
            ) : (
              <span title={segment.title}>{segment.text}</span>
            )}
          </Fragment>
        ))}
      </span>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={t('upNext.copyQueue', 'Copy as /queue text')}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text)
          } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error))
          }
        }}
      >
        <Copy />
      </Button>
    </div>
  )
}
