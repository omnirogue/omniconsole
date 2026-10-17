import { useDeferredValue, useMemo, useState } from 'react'
import { Check, FileText, Folder, FolderOpen, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { joinPath } from '@/lib/path'
import { useRuntimeFileListForWorktree } from '../quick-open-file-list'
import { prepareQuickOpenFiles, rankQuickOpenFiles } from '../quick-open-search'
import type { WorkflowContextSource } from '../../../../shared/workflow-context-sources'
import { WorkflowContextSearchSelect } from './WorkflowContextSearchSelect'
import { workflowContextFolderMatches, type WorkflowContextRoot } from './workflow-context-roots'

const FILE_LIMIT = 12

/**
 * Files and folders on this computer: a fuzzy search inside any local workspace (the Quick Open
 * index), and the system dialog for anything else. A row toggles its path in and out.
 */
export function WorkflowContextLocalSearch({
  worktreeId,
  roots,
  chosen,
  onToggle,
  onAdd
}: {
  worktreeId: string
  roots: readonly WorkflowContextRoot[]
  chosen: ReadonlySet<string>
  onToggle: (source: WorkflowContextSource) => void
  onAdd: (sources: WorkflowContextSource[]) => void
}) {
  const [rootId, setRootId] = useState(worktreeId)
  const [query, setQuery] = useState('')
  const deferred = useDeferredValue(query)
  const root: WorkflowContextRoot | undefined = roots.find((entry) => entry.worktreeId === rootId)
  const current = useAppStore((state) => state.getKnownWorktreeById(rootId) ?? null)
  const rootPath = root?.path ?? current?.path ?? ''
  const { files, loading, loadError } = useRuntimeFileListForWorktree({
    enabled: !!deferred.trim(),
    worktreeId: rootId,
    query: deferred
  })
  const indexed = useMemo(() => prepareQuickOpenFiles(files), [files])
  const matches = useMemo(() => {
    if (!deferred.trim()) {
      return []
    }
    const folders = workflowContextFolderMatches(files, deferred).map((path) => ({
      path,
      folder: true
    }))
    const found = rankQuickOpenFiles(deferred, indexed, FILE_LIMIT).map((file) => ({
      path: file.path,
      folder: false
    }))
    return [...folders, ...found]
  }, [deferred, files, indexed])
  const browse = async (folders: boolean) => {
    const paths = await window.api.localWorkflow.pickContextPaths({ folders })
    onAdd(paths.map((path) => ({ kind: 'path', path })))
  }
  const rootOptions = roots.some((entry) => entry.worktreeId === rootId)
    ? roots
    : [
        {
          worktreeId: rootId,
          label: current?.displayName ?? rootId,
          path: rootPath,
          branch: ''
        },
        ...roots
      ]
  return (
    <section className="space-y-2">
      <h4 className="text-xs font-medium">
        {translate('workflowGraph.context.local', 'On this computer')}
      </h4>
      <div className="flex min-w-0 items-center gap-2">
        <WorkflowContextSearchSelect
          label={translate('workflowGraph.context.workspace', 'Workspace')}
          placeholder={translate(
            'workflowGraph.context.workspaceSearch',
            'Search workspaces or branches…'
          )}
          value={rootId}
          options={rootOptions.map((entry) => ({ value: entry.worktreeId, label: entry.label }))}
          onChange={setRootId}
        />
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={!rootPath}
          onClick={() => onToggle({ kind: 'path', path: rootPath })}
        >
          {chosen.has(`path:${rootPath}`)
            ? translate('workflowGraph.context.removeWorkspace', 'Remove workspace')
            : translate('workflowGraph.context.addWorkspace', 'Add workspace')}
        </Button>
      </div>
      <p className="truncate text-xs text-muted-foreground" title={rootPath}>
        {rootPath}
      </p>
      <Input
        className="h-8 text-xs"
        value={query}
        aria-label={translate('workflowGraph.context.localSearch', 'Search files and folders')}
        placeholder={translate(
          'workflowGraph.context.localSearchPlaceholder',
          'Search files and folders…'
        )}
        onChange={(event) => setQuery(event.target.value)}
      />
      {deferred.trim() ? (
        <ul className="max-h-48 space-y-0.5 overflow-y-auto scrollbar-sleek">
          {matches.map((match) => {
            const path = rootPath ? joinPath(rootPath, match.path) : match.path
            const added = chosen.has(`path:${path}`)
            const Icon = added ? Check : match.folder ? Folder : FileText
            return (
              <li key={`${match.folder ? 'd' : 'f'}:${match.path}`}>
                <button
                  type="button"
                  className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs hover:bg-accent"
                  aria-pressed={added}
                  onClick={() => onToggle({ kind: 'path', path })}
                >
                  <Icon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
                  <span className="truncate">{match.path}</span>
                </button>
              </li>
            )
          })}
          {!matches.length && (
            <li
              className="px-1.5 py-1 text-xs text-muted-foreground"
              role={loadError && !loading ? 'alert' : undefined}
            >
              {loading
                ? translate('workflowGraph.context.searching', 'Searching…')
                : loadError
                  ? // Why: a failed listing (rg exit 2 on a broad folder) is not an empty result.
                    translate(
                      'workflowGraph.context.listFailed',
                      "Couldn't list files in this folder. Choose a project folder, or use Add files."
                    )
                  : translate('workflowGraph.context.noMatches', 'Nothing matches.')}
            </li>
          )}
        </ul>
      ) : null}
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="gap-1"
          onClick={() => void browse(false)}
        >
          <Plus aria-hidden="true" className="size-3" />
          {translate('workflowGraph.context.browseFiles', 'Add files…')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="gap-1"
          onClick={() => void browse(true)}
        >
          <FolderOpen aria-hidden="true" className="size-3" />
          {translate('workflowGraph.context.browseFolders', 'Add folders…')}
        </Button>
      </div>
    </section>
  )
}
