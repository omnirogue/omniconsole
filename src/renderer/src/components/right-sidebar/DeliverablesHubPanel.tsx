import { useEffect, useMemo, useRef, useState } from 'react'
import { FileText, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { launchWorkItemDirect } from '@/lib/launch-work-item-direct'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import type { DeliverableEntry, DeliverablesHubResult } from '../../../../shared/deliverables-hub'
import { deliverablesHubCopy } from './deliverables-hub-copy'

const REPO_STORAGE_KEY = 'deliverables-hub-repo-id'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default function DeliverablesHubPanel(): React.JSX.Element {
  const copy = deliverablesHubCopy()
  const api = window.api.deliverablesHub
  const repos = useAppStore((state) => state.repos)
  const localRepos = useMemo(
    () =>
      repos.filter(
        (repo) =>
          repo.kind !== 'folder' &&
          !repo.connectionId &&
          (!repo.executionHostId || repo.executionHostId === 'local')
      ),
    [repos]
  )
  const [repoId, setRepoId] = useState(() => localStorage.getItem(REPO_STORAGE_KEY) ?? '')
  const [query, setQuery] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  const lastRefreshKey = useRef(-1)
  const [result, setResult] = useState<DeliverablesHubResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [launching, setLaunching] = useState<string | null>(null)
  const selectedRepo = localRepos.find((repo) => repo.id === repoId)

  useEffect(() => {
    if (!api) {
      return
    }
    let current = true
    const timer = window.setTimeout(
      () => {
        setLoading(true)
        const refresh = refreshKey !== lastRefreshKey.current
        lastRefreshKey.current = refreshKey
        void api
          .search(query, refresh)
          .then(
            (next) => {
              if (current) {
                setResult(next)
                setError(null)
              }
            },
            (cause) => {
              if (current) {
                setError(errorText(cause))
              }
            }
          )
          .finally(() => {
            if (current) {
              setLoading(false)
            }
          })
      },
      query ? 180 : 0
    )
    return () => {
      current = false
      window.clearTimeout(timer)
    }
  }, [api, query, refreshKey])

  const resolve = async (entry: DeliverableEntry): Promise<string> => {
    if (!api) {
      throw new Error('Deliverables are unavailable in this window.')
    }
    return api.resolve(entry.relativePath, entry.modifiedAt)
  }

  const open = async (entry: DeliverableEntry): Promise<void> => {
    try {
      await window.api.shell.openPath(await resolve(entry))
    } catch (cause) {
      toast.error(errorText(cause))
    }
  }

  const launch = async (entry: DeliverableEntry): Promise<void> => {
    if (!selectedRepo || launching) {
      return
    }
    setLaunching(entry.relativePath)
    try {
      const agents = await useAppStore.getState().ensureDetectedAgents()
      if (!agents.includes('codex')) {
        throw new Error('Codex is unavailable on this computer.')
      }
      const path = await resolve(entry)
      const started = await launchWorkItemDirect({
        item: {
          title: entry.title,
          type: 'issue',
          number: null,
          url: '',
          pasteContent: [
            `Implement the deliverable at ${JSON.stringify(path)} in this worktree.`,
            'Read the source file, follow this repository’s AGENTS.md, implement the requested code,',
            'run the relevant checks, and report the result with evidence.'
          ].join(' ')
        },
        repoId: selectedRepo.id,
        baseBranch: selectedRepo.worktreeBaseRef,
        agentOverride: 'codex',
        promptDelivery: 'submit-after-ready',
        launchSource: 'sidebar',
        telemetrySource: 'sidebar',
        openModalFallback: () => toast.error('Choose a repository with a configured setup policy.')
      })
      if (started) {
        toast.success(deliverablesHubCopy().launched)
      }
    } catch (cause) {
      toast.error(errorText(cause))
    } finally {
      setLaunching(null)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="space-y-3 border-b border-border p-3">
        <p className="text-xs text-muted-foreground">{copy.subtitle}</p>
        <div className="flex gap-2">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={copy.searchPlaceholder}
            aria-label={copy.search}
          />
          <Button
            type="button"
            size="icon"
            variant="outline"
            aria-label={copy.refresh}
            onClick={() => setRefreshKey((value) => value + 1)}
          >
            <RefreshCw className={loading ? 'animate-spin' : ''} />
          </Button>
        </div>
        <Select
          value={selectedRepo?.id ?? ''}
          onValueChange={(value) => {
            setRepoId(value)
            localStorage.setItem(REPO_STORAGE_KEY, value)
          }}
        >
          <SelectTrigger className="w-full" aria-label={copy.repository}>
            <SelectValue placeholder={copy.chooseRepository} />
          </SelectTrigger>
          <SelectContent>
            {localRepos.map((repo) => (
              <SelectItem key={repo.id} value={repo.id}>
                {repo.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {result ? copy.summary(result.total, result.root) : copy.loading}
          {result?.skipped ? ` · ${copy.skipped(result.skipped)}` : ''}
        </p>
      </div>
      {!api && <p className="p-4 text-sm text-muted-foreground">{copy.desktopOnly}</p>}
      {error && (
        <p role="alert" className="p-4 text-sm text-destructive">
          {error}
        </p>
      )}
      {result && result.entries.length === 0 && !error && (
        <p className="p-4 text-sm text-muted-foreground">{copy.empty}</p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek divide-y divide-border">
        {result?.entries.map((entry) => (
          <article key={entry.relativePath} className="space-y-2 p-3 hover:bg-accent">
            <div className="flex items-start gap-2">
              <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <h3 className="text-sm font-medium text-foreground break-words">{entry.title}</h3>
                <p className="mt-1 text-xs text-muted-foreground break-all">
                  {entry.taskId ? `${entry.taskId} · ` : ''}
                  {entry.relativePath}
                </p>
              </div>
            </div>
            <p className="line-clamp-2 text-xs text-muted-foreground">{entry.excerpt}</p>
            <div className="flex items-center justify-between gap-2">
              <Button type="button" size="xs" variant="ghost" onClick={() => void open(entry)}>
                {copy.open}
              </Button>
              <span className="text-xs text-muted-foreground">
                {new Date(entry.modifiedAt).toLocaleDateString()}
              </span>
            </div>
            <Button
              type="button"
              size="sm"
              className="w-full text-xs"
              disabled={!selectedRepo || launching !== null}
              onClick={() => void launch(entry)}
              title={selectedRepo ? copy.launchIn(selectedRepo.displayName) : copy.chooseFirst}
            >
              {launching === entry.relativePath ? copy.launching : copy.launch}
            </Button>
          </article>
        ))}
      </div>
    </div>
  )
}
