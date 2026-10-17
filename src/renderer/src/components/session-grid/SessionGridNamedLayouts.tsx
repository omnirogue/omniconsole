import { useState } from 'react'
import { Columns2, LayoutTemplate, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useSessionGrid } from '@/store/session-grid'
import { SESSION_GRID_TEMPLATES } from '@/lib/session-grid-templates'
import { translate } from '@/i18n/i18n'
import { PaneContentMenu } from './PaneContentMenu'

export function SessionGridNamedLayouts({
  onAdd
}: {
  onAdd: (id: string) => void
}): React.JSX.Element {
  const grid = useSessionGrid()
  const [name, setName] = useState('')
  const active = grid.layouts.find((entry) => entry.id === grid.activeLayoutId)
  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="sm" className="gap-1.5">
            <LayoutTemplate className="size-3.5" />
            {active?.name ?? translate('commandCenter.layouts', 'Layouts')}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 space-y-2 p-3">
          <p className="text-xs font-medium">
            {translate('commandCenter.savedLayouts', 'Saved layouts')}
          </p>
          <div className="max-h-48 overflow-y-auto scrollbar-sleek">
            {grid.layouts.map((entry) => (
              <Button
                key={entry.id}
                variant="ghost"
                size="sm"
                className="w-full justify-start"
                data-current={entry.id === grid.activeLayoutId}
                onClick={() => grid.switchLayout(entry.id)}
              >
                {entry.name}
              </Button>
            ))}
          </div>
          <Input
            aria-label={translate('commandCenter.layoutName', 'Layout name')}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={translate('commandCenter.layoutName', 'Layout name')}
          />
          <div className="flex gap-1">
            <Button
              size="xs"
              disabled={!name.trim()}
              onClick={() => {
                grid.saveLayoutAs(name)
                setName('')
              }}
            >
              {translate('commandCenter.saveAs', 'Save as')}
            </Button>
            <Button
              variant="outline"
              size="xs"
              disabled={!name.trim()}
              onClick={() => {
                grid.renameLayout(grid.activeLayoutId, name)
                setName('')
              }}
            >
              {translate('commandCenter.rename', 'Rename')}
            </Button>
            <Button
              variant="ghost"
              size="xs"
              disabled={grid.layouts.length < 2}
              onClick={() => grid.deleteLayout(grid.activeLayoutId)}
            >
              {translate('commandCenter.deleteLayout', 'Delete layout')}
            </Button>
          </div>
          <p className="pt-2 text-xs font-medium">
            {translate('commandCenter.templates', 'Templates')}
          </p>
          <div className="flex flex-wrap gap-1">
            {SESSION_GRID_TEMPLATES.map((template) => (
              <Button
                key={template}
                variant="outline"
                size="xs"
                onClick={() => grid.applyTemplate(template)}
              >
                {translate(`commandCenter.template.${template}`, template)}
              </Button>
            ))}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start"
            onClick={grid.resetToDefault}
          >
            {translate('commandCenter.reset', 'Reset to default')}
          </Button>
        </PopoverContent>
      </Popover>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={translate('commandCenter.toggleOrientation', 'Toggle rows / columns')}
        title={translate('commandCenter.toggleOrientation', 'Toggle rows / columns')}
        onClick={grid.toggleOrientation}
      >
        <Columns2 className="size-3.5" />
      </Button>
      <span className="flex items-center gap-0.5 text-xs">
        <Plus className="size-3.5" aria-hidden />
        {translate('commandCenter.addContent', 'Add pane')}
        <PaneContentMenu onPick={onAdd} />
      </span>
    </>
  )
}

export function SessionGridStorageNotice(): React.JSX.Element | null {
  const status = useSessionGrid((state) => state.storageStatus)
  const writeBlocked = useSessionGrid((state) => state.writeBlocked)
  const retry = useSessionGrid((state) => state.retryWrites)
  if (status === 'healthy' || status === 'absent') {
    return null
  }
  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-2 border-b border-border bg-muted px-3 py-2 text-xs text-muted-foreground"
    >
      <span>
        {status === 'unwritable'
          ? translate(
              'commandCenter.unsaved',
              'Layout changes could not be saved. Keep this window open and retry.'
            )
          : status === 'unsupported'
            ? translate(
                'commandCenter.unsupported',
                'This layout was saved by a newer version. The original is preserved; changes here will not be saved.'
              )
            : translate(
                'commandCenter.corrupt',
                'Saved layouts could not be read safely. The original is preserved; changes here will not be saved.'
              )}
      </span>
      {status === 'unwritable' && !writeBlocked ? (
        <Button variant="outline" size="xs" onClick={retry}>
          {translate('commandCenter.retrySave', 'Retry save')}
        </Button>
      ) : null}
    </div>
  )
}
