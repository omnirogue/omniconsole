import { LayoutTemplate } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import type { SessionGridLayout } from '@/lib/session-grid-layout'
import {
  sameSessionGridPreset,
  sessionGridPreset,
  sessionGridPresets,
  type SessionGridPreset
} from '@/lib/session-grid-presets'
import { cn } from '@/lib/utils'

function presetLabel(preset: SessionGridPreset): string {
  const counts = preset.counts.join(' | ')
  return preset.orientation === 'columns'
    ? translate('sessionGrid.presetColumns', 'Columns: {{counts}}', { counts })
    : translate('sessionGrid.presetRows', 'Rows: {{counts}}', { counts })
}

/** A small picture of the arrangement: tracks of boxes, as the grid will draw them. */
function PresetThumbnail({ preset }: { preset: SessionGridPreset }): React.JSX.Element {
  const columns = preset.orientation === 'columns'
  return (
    <span className={cn('flex h-10 w-14 gap-0.5', columns ? 'flex-row' : 'flex-col')}>
      {preset.counts.map((count, track) => (
        <span key={track} className={cn('flex flex-1 gap-0.5', columns ? 'flex-col' : 'flex-row')}>
          {Array.from({ length: count }, (_, pane) => (
            <span key={pane} className="flex-1 rounded-[2px] bg-muted-foreground/35" />
          ))}
        </span>
      ))}
    </span>
  )
}

/** Picks how the panes are arranged: "2 | 1", "3 | 2", 2×2… in columns or in rows. */
export function SessionGridLayoutPicker(props: {
  layout: SessionGridLayout
  onApply: (preset: SessionGridPreset) => void
}): React.JSX.Element {
  const count = props.layout.tracks.flat().length
  const presets = sessionGridPresets(count)
  const current = sessionGridPreset(props.layout)
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-1.5" disabled={count < 2}>
          <LayoutTemplate className="size-3.5" />
          {translate('sessionGrid.layout', 'Layout')}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-2">
        <p className="px-1 pb-2 text-xs text-muted-foreground">
          {translate(
            'sessionGrid.layoutHelp',
            'Arrange {{count}} panes. Drag a pane’s header to fine-tune.',
            {
              count
            }
          )}
        </p>
        <div className="grid grid-cols-4 gap-1.5">
          {presets.map((preset) => {
            const selected = sameSessionGridPreset(preset, current)
            return (
              <button
                key={`${preset.orientation}:${preset.counts.join(',')}`}
                type="button"
                aria-label={presetLabel(preset)}
                title={presetLabel(preset)}
                aria-pressed={selected}
                onClick={() => props.onApply(preset)}
                className={cn(
                  'rounded-md border p-1.5 transition-colors hover:bg-accent',
                  selected ? 'border-ring bg-accent' : 'border-border'
                )}
              >
                <PresetThumbnail preset={preset} />
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
