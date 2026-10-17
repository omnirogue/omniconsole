import React, { useState } from 'react'
import { RotateCcw, Save, Settings2, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { SidebarGroupSettings } from './SidebarGroupSettings'
import {
  activeViewIsDirty,
  EMPTY_SIDEBAR_LAYOUT,
  hiddenEntries,
  isDefaultLayout
} from '../../../../shared/sidebar-layout'

/**
 * Where the sidebar is arranged: a Customize switch that reveals the per-row
 * controls, the list of rows the person put away so nothing is lost behind a
 * preference, and a reset.
 *
 * Customize is deliberately NOT persisted. The controls are a mode you enter to
 * rearrange and leave when you are done; a sidebar that always wears them reads
 * as an editor rather than a place to work.
 */
export function SidebarCustomizeMenu(): React.JSX.Element {
  const customizing = useAppStore((state) => state.sidebarCustomizing === true)
  const setCustomizing = useAppStore((state) => state.setSidebarCustomizing)
  // Same reason as the ordered group: absent means the default arrangement.
  const layout = useAppStore((state) => state.sidebarLayout ?? EMPTY_SIDEBAR_LAYOUT)
  const restore = useAppStore((state) => state.restoreSidebarRow)
  const reset = useAppStore((state) => state.resetSidebarLayout)
  const saveView = useAppStore((state) => state.saveSidebarView)
  const applyView = useAppStore((state) => state.applySidebarView)
  const deleteView = useAppStore((state) => state.deleteSidebarView)
  const [draft, setDraft] = useState('')
  const hidden = hiddenEntries(layout)
  const dirty = activeViewIsDirty(layout)
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          size="xs"
          variant="ghost"
          aria-label={translate('sidebar.customize', 'Customize sidebar')}
          data-sidebar-customize-trigger=""
        >
          <Settings2 className="size-3.5" aria-hidden />
          {hidden.length > 0 ? (
            <span className="tabular-nums text-[10px] text-muted-foreground">{hidden.length}</span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="scrollbar-sleek max-h-[80vh] w-72 space-y-3 overflow-y-auto text-xs"
      >
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={customizing}
            onChange={(event) => setCustomizing(event.target.checked)}
            className="size-3.5"
          />
          <span className="font-medium">
            {translate('sidebar.customizeSwitch', 'Customize sidebar')}
          </span>
        </label>
        <p className="text-muted-foreground">
          {translate(
            'sidebar.customizeHelp',
            'Drag the handles to reorder rows or move shortcuts between Work and Agents. Removed items can be added again here or in Settings → Appearance.'
          )}
        </p>
        <SidebarGroupSettings />
        <div className="space-y-1 border-t pt-2">
          <p className="font-medium">
            {translate('sidebar.hiddenItems', 'Hidden items · {{count}}', {
              count: hidden.length
            })}
          </p>
          {hidden.length === 0 ? (
            <p className="text-muted-foreground">
              {translate('sidebar.nothingHidden', 'Nothing is hidden.')}
            </p>
          ) : (
            <ul className="space-y-0.5">
              {hidden.map((entry) => (
                <li key={entry.id} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate">{entry.label}</span>
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-label={translate('sidebar.restoreRow', 'Restore {{label}}', {
                      label: entry.label
                    })}
                    onClick={() => restore(entry.id)}
                  >
                    {translate('sidebar.restore', 'Restore')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <p className="text-[11px] text-muted-foreground">
            {translate(
              'sidebar.hiddenReveal',
              'A hidden row still appears while it carries something that needs you.'
            )}
          </p>
        </div>
        <div className="space-y-1 border-t pt-2">
          <p className="font-medium">
            {translate('sidebar.savedViews', 'Saved arrangements · {{count}}', {
              count: layout.views.length
            })}
            {dirty ? (
              <span
                className="ml-1 text-muted-foreground"
                title={translate(
                  'sidebar.viewChangedDetail',
                  'The sidebar has changed since this arrangement was saved. Save it again under the same name to update it.'
                )}
              >
                {translate('sidebar.viewChanged', '· changed')}
              </span>
            ) : null}
          </p>
          {layout.views.length === 0 ? (
            <p className="text-muted-foreground">
              {translate(
                'sidebar.noViews',
                'Save the current arrangement to come back to it later.'
              )}
            </p>
          ) : (
            <ul className="space-y-0.5">
              {layout.views.map((view) => (
                <li key={view.id} className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    aria-pressed={layout.activeView === view.id}
                    onClick={() => applyView(view.id)}
                    className={`min-w-0 flex-1 truncate text-left ${
                      layout.activeView === view.id ? 'font-medium' : ''
                    }`}
                  >
                    {view.name}
                  </button>
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-label={translate('sidebar.deleteView', 'Delete {{name}}', {
                      name: view.name
                    })}
                    onClick={() => deleteView(view.id)}
                  >
                    <Trash2 className="size-3" aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <form
            className="flex items-center gap-1 pt-1"
            onSubmit={(event) => {
              event.preventDefault()
              const trimmed = draft.trim()
              if (trimmed === '') {
                return
              }
              saveView(trimmed)
              setDraft('')
            }}
          >
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              maxLength={80}
              placeholder={translate('sidebar.viewNamePlaceholder', 'Name this arrangement')}
              aria-label={translate('sidebar.viewName', 'Arrangement name')}
              className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-xs"
            />
            <Button size="xs" variant="outline" type="submit" disabled={draft.trim() === ''}>
              <Save className="size-3" aria-hidden />
              {translate('sidebar.saveView', 'Save')}
            </Button>
          </form>
          {/* Why it says so: naming an existing arrangement updates it rather than
              quietly making a second one with the same name. */}
          <p className="text-[11px] text-muted-foreground">
            {translate(
              'sidebar.saveViewHelp',
              'Saving under a name you already used updates that arrangement.'
            )}
          </p>
        </div>
        <div className="border-t pt-2">
          <Button
            size="xs"
            variant="outline"
            disabled={isDefaultLayout(layout)}
            onClick={reset}
            aria-label={translate('sidebar.resetLayout', 'Reset the sidebar arrangement')}
          >
            <RotateCcw className="size-3" aria-hidden />
            {translate('sidebar.reset', 'Reset arrangement')}
          </Button>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {translate(
              'sidebar.resetKeepsViews',
              'Reset restores the built-in order and keeps your saved arrangements.'
            )}
          </p>
        </div>
      </PopoverContent>
    </Popover>
  )
}
