import { useMemo, useState } from 'react'
import { Check, FileText, Folder } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Command, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { joinPath } from '@/lib/path'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { useRuntimeFileListForWorktree } from '../quick-open-file-list'
import { prepareQuickOpenFiles, rankQuickOpenFiles } from '../quick-open-search'
import { workflowContextFolderMatches } from '../workflow-graph/workflow-context-roots'
import type { SessionContextAttachment } from '../../../../shared/session-context-attachments'

export function SessionContextFiles({
  worktreeId,
  chosen,
  busy,
  onAdd,
  onError
}: {
  worktreeId: string | null
  chosen: ReadonlySet<string>
  busy: boolean
  onAdd: (items: SessionContextAttachment[]) => Promise<void>
  onError: (message: string) => void
}) {
  const [query, setQuery] = useState('')
  const worktree = useAppStore((state) =>
    worktreeId ? state.getKnownWorktreeById(worktreeId) : null
  )
  const folderPath = useAppStore(
    (state) =>
      state.folderWorkspaces.find((folder) => `folder:${folder.id}` === worktreeId)?.folderPath
  )
  const hostId = useAppStore((state) =>
    worktreeId ? getExecutionHostIdForWorktree(state, worktreeId) : 'local'
  )
  const rootPath = worktree?.path ?? folderPath
  const { files, loading, loadError } = useRuntimeFileListForWorktree({
    enabled: Boolean(query.trim() && worktreeId),
    worktreeId,
    query
  })
  const indexed = useMemo(() => prepareQuickOpenFiles(files), [files])
  const matches = useMemo(
    () =>
      query.trim()
        ? [
            ...workflowContextFolderMatches(files, query).map((path) => ({
              path,
              kind: 'folder' as const
            })),
            ...rankQuickOpenFiles(query, indexed, 20).map((file) => ({
              path: file.path,
              kind: 'file' as const
            }))
          ]
        : [],
    [files, query, indexed]
  )
  const addPaths = async (paths: string[], kind: 'file' | 'folder', sourceHost: string) => {
    try {
      await onAdd(
        paths.map((uri) => ({
          id: `${kind}:${sourceHost}:${uri}`,
          kind,
          title: uri.split(/[\\/]/).findLast(Boolean) ?? uri,
          uri,
          hostId: sourceHost
        }))
      )
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    }
  }
  const browse = async (folders: boolean) => {
    try {
      const paths = await window.api.localWorkflow.pickContextPaths({ folders })
      if (paths.length) {
        await addPaths(paths, folders ? 'folder' : 'file', 'local')
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    }
  }
  return (
    <div className="space-y-2">
      {worktreeId && rootPath && (
        <Command shouldFilter={false} className="h-auto border">
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={translate(
              'sessionContext.searchFiles',
              'Search project files and folders…'
            )}
          />
          <CommandList className="max-h-48">
            {matches.map((match) => {
              const uri = joinPath(rootPath, match.path)
              const id = `${match.kind}:${hostId}:${uri}`
              const Icon = chosen.has(id) ? Check : match.kind === 'folder' ? Folder : FileText
              return (
                <CommandItem
                  key={id}
                  value={id}
                  disabled={busy || !hostId || chosen.has(id)}
                  onSelect={() => {
                    if (hostId) {
                      void addPaths([uri], match.kind, hostId)
                    }
                  }}
                >
                  <Icon className="size-3.5" />
                  <span className="truncate">{match.path}</span>
                </CommandItem>
              )
            })}
            {loading && (
              <p role="status" className="p-2 text-xs text-muted-foreground">
                {translate('sessionContext.searching', 'Searching…')}
              </p>
            )}
            {loadError && (
              <p role="alert" className="p-2 text-xs text-destructive">
                {loadError}
              </p>
            )}
            {!loading && !loadError && query.trim() && !matches.length && (
              <p className="p-2 text-xs text-muted-foreground">
                {translate('sessionContext.noFiles', 'No files or folders found.')}
              </p>
            )}
          </CommandList>
        </Command>
      )}
      {hostId === 'local' && (
        <div className="flex flex-wrap gap-2">
          <Button size="xs" variant="outline" disabled={busy} onClick={() => void browse(false)}>
            <FileText className="size-3" />
            {translate('sessionContext.addFiles', 'Add files…')}
          </Button>
          <Button size="xs" variant="outline" disabled={busy} onClick={() => void browse(true)}>
            <Folder className="size-3" />
            {translate('sessionContext.addFolders', 'Add folders…')}
          </Button>
        </div>
      )}
    </div>
  )
}
