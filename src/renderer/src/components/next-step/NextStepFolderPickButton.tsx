import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { RemoteFileBrowser } from '@/components/sidebar/RemoteFileBrowser'
import { translate } from '@/i18n/i18n'
import { parseExecutionHostId } from '../../../../shared/execution-host'

/**
 * One button that picks a folder wherever the session runs: the native chooser on this
 * computer, the host's own file browser over SSH or a runtime. The remote browser opens as a
 * dialog, so it stacks above the Next actions surface.
 */
export function NextStepFolderPickButton({
  hostId,
  currentFolder,
  onPick,
  children,
  variant = 'outline'
}: {
  hostId: string
  currentFolder: string
  onPick: (path: string) => void
  children?: ReactNode
  variant?: 'outline' | 'ghost'
}): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const [remoteOpen, setRemoteOpen] = useState(false)
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  const host = parseExecutionHostId(hostId)
  const pick = async (): Promise<void> => {
    setError(null)
    try {
      if (host?.kind === 'local') {
        const picked = await window.api.shell.pickDirectory({ defaultPath: currentFolder })
        if (picked && live.current) {
          onPick(picked)
        }
      } else if (host?.kind === 'ssh' || host?.kind === 'runtime') {
        setRemoteOpen(true)
      } else {
        setError(
          translate('nextStep.hostUnavailable', 'The session execution host is unavailable.')
        )
      }
    } catch (cause) {
      if (live.current) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    }
  }
  const select = (path: string): void => {
    onPick(path)
    setRemoteOpen(false)
  }
  return (
    <>
      <Button type="button" size="xs" variant={variant} onClick={() => void pick()}>
        {children ?? translate('nextStep.chooseFolder', 'Choose folder…')}
      </Button>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <Dialog open={remoteOpen} onOpenChange={setRemoteOpen}>
        <DialogContent className="max-w-md sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {translate('nextStep.browseHostFilesystem', 'Browse host filesystem')}
            </DialogTitle>
            <DialogDescription>
              {translate(
                'nextStep.browseHostFilesystemDescription',
                'Navigate to a directory and click Select to choose it.'
              )}
            </DialogDescription>
          </DialogHeader>
          {host?.kind === 'ssh' ? (
            <RemoteFileBrowser
              targetId={host.targetId}
              initialPath={currentFolder}
              onSelect={select}
              onCancel={() => setRemoteOpen(false)}
            />
          ) : host?.kind === 'runtime' ? (
            <RemoteFileBrowser
              runtimeEnvironmentId={host.environmentId}
              initialPath={currentFolder}
              onSelect={select}
              onCancel={() => setRemoteOpen(false)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  )
}
