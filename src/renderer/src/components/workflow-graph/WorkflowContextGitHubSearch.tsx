import { useEffect, useState } from 'react'
import { Check, Github, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import type { WorkflowGitHubRepoHit } from '../../../../shared/workflow-context-ipc'
import type { WorkflowContextSource } from '../../../../shared/workflow-context-sources'
import { WorkflowContextSearchSelect } from './WorkflowContextSearchSelect'
import type { WorkflowContextRoot } from './workflow-context-roots'
import { workflowContextLocalCopies } from './workflow-context-roots'

const DEFAULT_BRANCH = ''

/** One repository row, opened: an optional branch, or a local copy, then Add. */
function RepoChoice({
  hit,
  roots,
  onAdd
}: {
  hit: WorkflowGitHubRepoHit
  roots: readonly WorkflowContextRoot[]
  onAdd: (source: WorkflowContextSource) => void
}) {
  const [branches, setBranches] = useState<string[]>()
  const [ref, setRef] = useState(DEFAULT_BRANCH)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    void window.api.localWorkflow.listContextBranches({ repo: hit.repo }).then((result) => {
      if (!live) {
        return
      }
      if ('error' in result) {
        setError(result.error)
      } else {
        setBranches(result.branches)
      }
    })
    return () => {
      live = false
    }
  }, [hit.repo])
  const copies = workflowContextLocalCopies(roots, hit.repo)
  const defaultLabel = hit.defaultBranch
    ? translate('workflowGraph.context.defaultBranchNamed', 'Default branch ({{name}})', {
        name: hit.defaultBranch
      })
    : translate('workflowGraph.context.defaultBranch', 'Default branch')
  return (
    <div className="space-y-1.5 rounded-md border bg-muted/30 p-2">
      <div className="flex min-w-0 items-center gap-2">
        <WorkflowContextSearchSelect
          label={translate('workflowGraph.context.branch', 'Branch')}
          placeholder={translate('workflowGraph.context.branchSearch', 'Search branches…')}
          value={ref}
          options={[
            { value: DEFAULT_BRANCH, label: defaultLabel },
            ...(branches ?? []).map((name) => ({ value: name, label: name }))
          ]}
          onChange={setRef}
        />
        <Button
          type="button"
          size="xs"
          onClick={() => onAdd({ kind: 'github', repo: hit.repo, ...(ref ? { ref } : {}) })}
        >
          {translate('workflowGraph.context.addRepo', 'Add')}
        </Button>
      </div>
      {error ? <p className="text-xs text-muted-foreground">{error}</p> : null}
      {!branches && !error ? (
        <p role="status" className="text-xs text-muted-foreground">
          {translate('workflowGraph.context.loadingBranches', 'Loading branches…')}
        </p>
      ) : null}
      {copies.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-xs text-muted-foreground">
            {translate('workflowGraph.context.localCopy', 'Or use a copy on this computer:')}
          </span>
          {copies.map((copy) => (
            <Button
              key={copy.worktreeId}
              type="button"
              variant="outline"
              size="xs"
              title={copy.path}
              onClick={() => onAdd({ kind: 'path', path: copy.path })}
            >
              {copy.branch || copy.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * GitHub repositories through the person's own `gh` login: their own and their organizations'
 * when the box is empty, GitHub's search otherwise. The branch is optional.
 */
export function WorkflowContextGitHubSearch({
  roots,
  chosen,
  onAdd
}: {
  roots: readonly WorkflowContextRoot[]
  chosen: ReadonlySet<string>
  onAdd: (source: WorkflowContextSource) => void
}) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<WorkflowGitHubRepoHit[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState<string>()
  useEffect(() => {
    let live = true
    setLoading(true)
    // Typing pauses before searching, to spare the person's GitHub rate limit.
    const timer = window.setTimeout(() => {
      void window.api.localWorkflow.searchContextRepos({ query }).then((result) => {
        if (!live) {
          return
        }
        setLoading(false)
        setError('error' in result ? result.error : '')
        setHits('error' in result ? [] : result.repos)
      })
    }, 350)
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [query])
  return (
    <section className="space-y-2">
      <h4 className="text-xs font-medium">{translate('workflowGraph.context.github', 'GitHub')}</h4>
      <Input
        className="h-8 text-xs"
        value={query}
        aria-label={translate('workflowGraph.context.githubSearch', 'Search GitHub repositories')}
        placeholder={translate(
          'workflowGraph.context.githubSearchPlaceholder',
          'Search any repository, or owner/name…'
        )}
        onChange={(event) => setQuery(event.target.value)}
      />
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <ul className="max-h-72 space-y-0.5 overflow-y-auto scrollbar-sleek">
        {loading && !hits.length ? (
          <li className="flex items-center gap-1.5 px-1.5 py-1 text-xs text-muted-foreground">
            <Loader2 aria-hidden="true" className="size-3 animate-spin" />
            {translate('workflowGraph.context.searching', 'Searching…')}
          </li>
        ) : null}
        {hits.map((hit) => {
          const added = [...chosen].some((key) =>
            key.startsWith(`github:${hit.repo.toLowerCase()}@`)
          )
          return (
            <li key={hit.repo} className="space-y-1">
              <button
                type="button"
                className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs hover:bg-accent"
                aria-expanded={open === hit.repo}
                onClick={() => setOpen(open === hit.repo ? undefined : hit.repo)}
              >
                {added ? (
                  <Check aria-hidden="true" className="size-3 shrink-0 text-status-success" />
                ) : (
                  <Github aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 truncate font-medium" title={hit.repo}>
                  {hit.repo}
                </span>
                <span className="truncate text-muted-foreground">{hit.description}</span>
              </button>
              {open === hit.repo && (
                <RepoChoice
                  hit={hit}
                  roots={roots}
                  onAdd={(source) => {
                    onAdd(source)
                    setOpen(undefined)
                  }}
                />
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
