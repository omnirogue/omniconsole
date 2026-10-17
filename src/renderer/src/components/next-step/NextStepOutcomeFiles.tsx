import { useEffect, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { getCompanyFolderHome } from '@/lib/company-folder-home'
import { useRecentFolders, useSessionPlaces } from '@/store/session-place-store'
import { getRuntimePathBasename, resolveRuntimePath } from '../../../../shared/cross-platform-path'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import type { NextStepHandoffOptions } from '../../../../shared/next-step-draft'
import { NextStepFolderPickButton } from './NextStepFolderPickButton'
import { folderGlance, type NextStepOutcomeFacts } from './next-step-outcome-facts'
import { useHoverOpenPopover } from './use-hover-open-popover'

/**
 * Where the finished files go, as one line: the session's own folder unless changed here.
 * Hovering or clicking the line opens the small chooser — this computer's Desktop and
 * Downloads, recent folders, the native or host picker, a typed path. The repository is never
 * chosen here: the agent knows it from the workspace.
 */
export function NextStepOutcomeFiles({
  facts,
  handoff,
  onHandoffChange
}: {
  facts: NextStepOutcomeFacts
  handoff: NextStepHandoffOptions
  onHandoffChange: (patch: Partial<NextStepHandoffOptions>) => void
}): React.JSX.Element {
  const recent = useRecentFolders()
  const rememberFolder = useSessionPlaces((state) => state.rememberFolder)
  const [home, setHome] = useState('')
  const [typed, setTyped] = useState('')
  const [open, setOpen] = useState(false)
  const hover = useHoverOpenPopover({ open, onOpenChange: setOpen })
  const hostId = facts.session.hostId ?? 'local'
  const local = parseExecutionHostId(hostId)?.kind === 'local'
  useEffect(() => {
    if (!local) {
      return
    }
    let live = true
    void getCompanyFolderHome().then((value) => {
      if (live) {
        setHome(value)
      }
    })
    return () => {
      live = false
    }
  }, [local])
  const workspacePath = facts.workspacePath ?? ''
  const destination = handoff.destinationDirectory ?? workspacePath
  const choose = (path: string): void => {
    const folder = path.trim()
    if (!folder) {
      return
    }
    // Why: the session's own folder is the default, not a change worth remembering.
    onHandoffChange({ destinationDirectory: folder === workspacePath ? undefined : folder })
    if (folder !== workspacePath) {
      rememberFolder(folder)
    }
  }
  // Why: Desktop and Downloads are this computer's; a remote host's home is not known here.
  const standard =
    local && home
      ? [resolveRuntimePath(home, 'Desktop'), resolveRuntimePath(home, 'Downloads')]
      : []
  const chips = [...standard, ...recent.filter((path) => !standard.includes(path))].filter(
    (path) => path !== workspacePath
  )
  const applyTyped = (): void => {
    choose(typed)
    setTyped('')
  }
  return (
    <Popover open={open} onOpenChange={hover.onOpenChange}>
      <PopoverAnchor asChild>
        <button
          type="button"
          className="flex w-full min-w-0 items-center gap-1.5 rounded-sm text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          aria-haspopup="dialog"
          aria-expanded={open}
          title={destination}
          data-next-step-files={handoff.destinationDirectory ? 'changed' : 'default'}
          {...hover.anchorProps}
        >
          <FolderOpen className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">
            {translate('nextStep.savesTo', 'Saves to {{folder}}', {
              folder: destination ? folderGlance(destination) : '…'
            })}
          </span>
          {handoff.destinationDirectory ? (
            <span className="shrink-0 text-[10px] uppercase tracking-[0.05em]">
              {translate('nextStep.folderChanged', 'changed')}
            </span>
          ) : null}
        </button>
      </PopoverAnchor>
      <PopoverContent
        side="bottom"
        align="start"
        className="w-[min(320px,calc(100vw-1rem))] space-y-2 p-2 text-xs"
        aria-label={translate('nextStep.saveFilesTo', 'Save files to')}
        {...hover.contentProps}
      >
        <p className="truncate text-[11px] text-muted-foreground" title={destination}>
          {destination}
        </p>
        <div
          className="flex flex-wrap gap-1"
          role="group"
          aria-label={translate('nextStep.recentFolders', 'Recent folders')}
        >
          {chips.map((path) => (
            <Button
              key={path}
              type="button"
              size="xs"
              variant={destination === path ? 'secondary' : 'outline'}
              aria-pressed={destination === path}
              title={path}
              onClick={() => choose(path)}
            >
              {getRuntimePathBasename(path) || path}
            </Button>
          ))}
          <NextStepFolderPickButton hostId={hostId} currentFolder={destination} onPick={choose} />
          {handoff.destinationDirectory ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => onHandoffChange({ destinationDirectory: undefined })}
            >
              {translate('nextStep.useSessionFolder', 'Use default')}
            </Button>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          <Input
            aria-label={translate('nextStep.folderPath', 'Folder path')}
            className="h-7 min-w-0 flex-1 text-xs"
            placeholder={destination}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && typed.trim()) {
                event.preventDefault()
                applyTyped()
              }
            }}
          />
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={!typed.trim()}
            onClick={applyTyped}
          >
            {translate('nextStep.useFolder', 'Use')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
