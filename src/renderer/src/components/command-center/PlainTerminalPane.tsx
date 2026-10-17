import { useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { sidebarSessionWorkspace } from '@/lib/sidebar-session-context'
import {
  createCommandCenterTerminal,
  TerminalCreationUnverifiableError
} from '@/lib/command-center-terminal-creation'
import { Button } from '../ui/button'
import { translate } from '@/i18n/i18n'

export default function PlainTerminalPane({
  paneId
}: {
  paneId: string
}): React.JSX.Element | null {
  const enabled = useAppStore((state) => state.settings?.commandCenter === true)
  const workspaces = useAppStore(
    useShallow((state) => [
      ...Object.values(state.worktreesByRepo)
        .flat()
        .map((entry) => entry.id),
      ...state.folderWorkspaces.map((entry) => folderWorkspaceKey(entry.id))
    ])
  )
  const active = useAppStore((state) => state.activeWorktreeId)
  const [workspace, setWorkspace] = useState(active ?? workspaces[0] ?? '')
  const busyRef = useRef(false)
  const [uncertain, setUncertain] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const create = async (): Promise<void> => {
    if (busyRef.current || uncertain || !workspace) {
      return
    }
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await createCommandCenterTerminal(paneId, workspace)
    } catch (cause) {
      if (cause instanceof TerminalCreationUnverifiableError) {
        setUncertain(true)
      }
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }
  if (!enabled) {
    return null
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-4">
      <label className="flex flex-col gap-1 text-xs">
        {translate('commandCenter.terminal.workspace', 'Workspace')}
        <select
          aria-label={translate('commandCenter.terminal.workspaceLabel', 'Terminal workspace')}
          value={workspace}
          disabled={busy}
          onChange={(event) => setWorkspace(event.target.value)}
          className="max-w-full rounded-md border bg-background p-2"
        >
          <option value="" disabled>
            {translate('commandCenter.terminal.chooseWorkspace', 'Choose a workspace')}
          </option>
          {workspaces.map((id) => (
            <option key={id} value={id}>
              {sidebarSessionWorkspace(useAppStore.getState(), id).workspaceLabel}
            </option>
          ))}
        </select>
      </label>
      <Button size="sm" disabled={!workspace || busy || uncertain} onClick={() => void create()}>
        {translate('commandCenter.terminal.create', 'Create terminal')}
      </Button>
      {uncertain ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'commandCenter.terminal.uncertain',
            'Creation could not be verified. Check this workspace on its execution computer before trying again.'
          )}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
