import { useContext, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { ConfirmationDialogContext } from '@/components/confirmation-dialog-context'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { BackgroundRuntimeTerminal } from '../../../../../shared/background-runtime-terminal'
import {
  backgroundTerminalsInHostFilter,
  backgroundTerminalsOutsideSidebar,
  endBackgroundTerminal,
  isBackgroundTerminalStillRunning,
  openBackgroundTerminal,
  useBackgroundRuntimeTerminals,
  watchBackgroundRuntimeTerminals
} from './background-runtime-terminals'

function terminalName(terminal: BackgroundRuntimeTerminal): string {
  return terminal.title?.trim() || translate('conversations.backgroundTerminalUntitled', 'Terminal')
}

function workspaceLabel(terminal: BackgroundRuntimeTerminal): string {
  const separator = terminal.worktreeId.indexOf('::')
  const path = separator === -1 ? terminal.worktreeId : terminal.worktreeId.slice(separator + 2)
  return path.split(/[\\/]/).findLast(Boolean) ?? path
}

// Why stored: the list can be long and crowd out the conversations, so it stays as the person left it.
export const BACKGROUND_TERMINALS_EXPANDED_STORAGE_KEY = 'omni.sidebar.backgroundTerminalsExpanded'

function readExpanded(): boolean {
  try {
    return window.localStorage.getItem(BACKGROUND_TERMINALS_EXPANDED_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

function writeExpanded(expanded: boolean): void {
  try {
    window.localStorage.setItem(BACKGROUND_TERMINALS_EXPANDED_STORAGE_KEY, String(expanded))
  } catch {
    // Why ignored: without storage the section still toggles for this window.
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * "Running in the background": processes this computer runs that no window tab shows (for example
 * one an earlier click from another computer started). Open adopts one into the window; End stops
 * it after the confirmation ending a running session always asks. Nothing here ends one by itself.
 * Collapsed to its one-line heading by default so it never hides the conversations above it.
 */
export function BackgroundTerminalsGroup(): React.JSX.Element | null {
  useEffect(() => watchBackgroundRuntimeTerminals(), [])
  const terminals = useBackgroundRuntimeTerminals((state) => state.terminals)
  const hostFilter = useBackgroundRuntimeTerminals((state) => state.hostFilter)
  const sidebarPaneKeys = useBackgroundRuntimeTerminals((state) => state.sidebarPaneKeys)
  const shown = useMemo(
    () =>
      backgroundTerminalsInHostFilter(
        backgroundTerminalsOutsideSidebar(terminals, sidebarPaneKeys),
        hostFilter
      ),
    [terminals, sidebarPaneKeys, hostFilter]
  )
  // Why the raw context: with no dialog (tests, previews) a running process is never ended unasked.
  const confirm = useContext(ConfirmationDialogContext)
  const [busy, setBusy] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(readExpanded)
  if (shown.length === 0) {
    return null
  }

  const open = async (terminal: BackgroundRuntimeTerminal): Promise<void> => {
    setBusy(terminal.ptyId)
    try {
      await openBackgroundTerminal(terminal.handle)
    } catch (error) {
      toast.error(
        translate('conversations.backgroundTerminalOpenFailed', 'Could not open {{name}}', {
          name: terminalName(terminal)
        }),
        { description: errorText(error) }
      )
    } finally {
      setBusy(null)
    }
  }

  const end = async (terminal: BackgroundRuntimeTerminal): Promise<void> => {
    const name = terminalName(terminal)
    // Why a fresh read first: the person must not confirm ending something already adopted or gone.
    if (!(await isBackgroundTerminalStillRunning(terminal.ptyId))) {
      toast.info(
        translate(
          'conversations.backgroundTerminalGone',
          '{{name}} is no longer running in the background.',
          { name }
        )
      )
      return
    }
    const confirmed = await confirm?.({
      title: translate('conversations.backgroundTerminalEndTitle', 'End this background process?'),
      description: translate(
        'conversations.backgroundTerminalEndDescription',
        '“{{name}}” is running in the background, not in a window. Ending it stops the process.',
        { name }
      ),
      confirmLabel: translate('conversations.backgroundTerminalEndConfirm', 'End process'),
      confirmVariant: 'destructive'
    })
    if (!confirmed) {
      return
    }
    setBusy(terminal.ptyId)
    try {
      await endBackgroundTerminal(terminal.ptyId)
      toast.success(translate('conversations.backgroundTerminalEnded', 'Ended {{name}}', { name }))
    } catch (error) {
      toast.error(
        translate('conversations.backgroundTerminalEndFailed', 'Could not end {{name}}', { name }),
        { description: errorText(error) }
      )
    } finally {
      setBusy(null)
    }
  }

  const heading = translate('conversations.backgroundTerminalsHeading', 'Running in the background')
  return (
    <section
      aria-label={heading}
      className="shrink-0 border-t border-worktree-sidebar-border px-2 py-1"
    >
      <button
        type="button"
        aria-expanded={expanded}
        className="flex w-full items-center gap-1 rounded px-1 pb-0.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
        onClick={() => {
          writeExpanded(!expanded)
          setExpanded(!expanded)
        }}
      >
        {expanded ? (
          <ChevronDown className="size-3 shrink-0" />
        ) : (
          <ChevronRight className="size-3 shrink-0" />
        )}
        <span className="truncate">
          {heading} · {shown.length}
        </span>
      </button>
      {expanded ? (
        <ul className="worktree-sidebar-scrollbar max-h-[30vh] space-y-0.5 overflow-y-auto">
          {shown.map((terminal) => {
            const name = terminalName(terminal)
            return (
              <li key={terminal.ptyId} className="flex min-w-0 items-center gap-1 px-1">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs">{name}</div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {translate(
                      'conversations.backgroundTerminalCaption',
                      'Running in the background, not in a window · {{workspace}}',
                      { workspace: workspaceLabel(terminal) }
                    )}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={busy === terminal.ptyId}
                  aria-label={translate(
                    'conversations.backgroundTerminalOpenLabel',
                    'Open {{name}}',
                    {
                      name
                    }
                  )}
                  onClick={() => void open(terminal)}
                >
                  {translate('conversations.backgroundTerminalOpen', 'Open')}
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={busy === terminal.ptyId}
                  aria-label={translate(
                    'conversations.backgroundTerminalEndLabel',
                    'End {{name}}',
                    {
                      name
                    }
                  )}
                  onClick={() => void end(terminal)}
                >
                  {translate('conversations.backgroundTerminalEnd', 'End')}
                </Button>
              </li>
            )
          })}
        </ul>
      ) : null}
    </section>
  )
}
