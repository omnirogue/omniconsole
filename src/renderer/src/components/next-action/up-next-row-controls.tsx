import { translate as t } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'

/**
 * ↑ ↓ ✕ for a row that can still move (amendment 12): invisible until the row is hovered or
 * holds focus, always shown under 860px, and never absent from the layout — opacity, not
 * display, so hovering a row shifts nothing. An end cap (handoff, Done) has ✕ only.
 */
export function UpNextRowControls({
  cap,
  disabled,
  upDisabled,
  downDisabled,
  onMove,
  onRemove
}: {
  cap: boolean
  disabled: boolean
  upDisabled: boolean
  downDisabled: boolean
  onMove: (direction: -1 | 1) => void
  onRemove: () => void
}): React.JSX.Element {
  return (
    <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 max-[860px]:opacity-100">
      {!cap && (
        <>
          <Button
            size="icon-xs"
            variant="ghost"
            title={t('upNext.moveUp', 'Move up')}
            aria-label={t('upNext.moveUp', 'Move up')}
            disabled={disabled || upDisabled}
            onClick={() => onMove(-1)}
          >
            ↑
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            title={t('upNext.moveDown', 'Move down')}
            aria-label={t('upNext.moveDown', 'Move down')}
            disabled={disabled || downDisabled}
            onClick={() => onMove(1)}
          >
            ↓
          </Button>
        </>
      )}
      <Button
        size="icon-xs"
        variant="ghost"
        title={t('upNext.remove', 'Remove')}
        aria-label={t('upNext.remove', 'Remove')}
        disabled={disabled}
        onClick={onRemove}
      >
        ✕
      </Button>
    </span>
  )
}
