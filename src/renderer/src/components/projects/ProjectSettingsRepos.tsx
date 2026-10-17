import { Suspense, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Plus, Search } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import { lazyWithRetry } from '@/lib/lazy-with-retry'
import { useAppStore } from '@/store'
import type { AddRepoDialogHostedController } from '@/components/sidebar/use-add-repo-hosted-controller'
import { getRepoGitIdentity } from '../../../../shared/folder-workspace-attached-repos'
import type { ProjectRepo } from '../../../../shared/project-settings'
import type { Repo } from '../../../../shared/repo-types'
import { closeProjectSettings } from './project-settings-dialog-store'
import { projectRepoChoices, type ProjectRepoChoice } from './project-settings-draft'

// Why lazy: the add flow (clone, SSH hosts, nested scans) is off the dialog's hot path.
const HostedAddRepoDialog = lazyWithRetry(() => import('@/components/sidebar/AddRepoDialog'), {
  reloadKey: 'project-settings-add-repo'
})

/** Show the filter once the list is long enough that scanning it is slower than typing. */
const REPO_SEARCH_MIN_ROWS = 4

function repoChoiceMatches(choice: ProjectRepoChoice, query: string): boolean {
  return (
    choice.label.toLowerCase().includes(query) || choice.gitIdentity.toLowerCase().includes(query)
  )
}

/** Pinned (chosen when the dialog opened, or just added) first, then addable, then by name. */
export function orderProjectRepoChoices(
  rows: readonly ProjectRepoChoice[],
  pinned: ReadonlySet<string>
): ProjectRepoChoice[] {
  return [...rows].sort((a, b) => {
    const pinnedDiff = Number(pinned.has(b.gitIdentity)) - Number(pinned.has(a.gitIdentity))
    if (pinnedDiff !== 0) {
      return pinnedDiff
    }
    const remoteDiff = Number(b.hasRemote) - Number(a.hasRemote)
    if (remoteDiff !== 0) {
      return remoteDiff
    }
    return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })
  })
}

/** Repos registered since the add dialog opened, split by whether a project can hold them. */
export function newlyRegisteredRepos(
  before: ReadonlySet<string>,
  now: readonly Pick<Repo, 'id' | 'path' | 'displayName' | 'gitRemoteIdentity'>[]
): { identities: string[]; withoutRemote: string[] } {
  const identities: string[] = []
  const withoutRemote: string[] = []
  for (const repo of now) {
    if (before.has(repo.id)) {
      continue
    }
    const identity = getRepoGitIdentity(repo)
    if (identity.startsWith('path:')) {
      withoutRemote.push(repo.displayName)
    } else if (!identities.includes(identity)) {
      identities.push(identity)
    }
  }
  return { identities, withoutRemote }
}

/** Repos by remote identity, so the project finds each on any computer; never a path. */
export function ProjectSettingsRepos({
  repos,
  onChange
}: {
  repos: readonly ProjectRepo[]
  onChange: (next: ProjectRepo[]) => void
}): React.JSX.Element {
  const registered = useAppStore((state) => state.repos)
  const [query, setQuery] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  // Why: not mounted until first open, so dialogs that never add a repo never fetch the chunk.
  const [addMounted, setAddMounted] = useState(false)
  // Why a snapshot: sorting by the live picks would move a row the moment its box is ticked.
  const [pinned, setPinned] = useState(() => new Set(repos.map((repo) => repo.gitIdentity)))
  // Why ids, not a count: the add flow can register several repos (multi-pick, nested import).
  const repoIdsBeforeAdd = useRef<Set<string> | null>(null)
  // Why refs: the hosted dialog's callbacks fire after this render's props are stale.
  const latest = useRef({ repos, onChange })
  useLayoutEffect(() => {
    latest.current = { repos, onChange }
  }, [repos, onChange])
  const choices = projectRepoChoices(registered)
  const known = new Set(choices.map((choice) => choice.gitIdentity))
  // Why: a repo saved on another computer stays listed here even if this one lacks it.
  const elsewhere: ProjectRepoChoice[] = repos
    .filter((repo) => !known.has(repo.gitIdentity))
    .map((repo) => ({
      gitIdentity: repo.gitIdentity,
      label: repo.gitIdentity,
      hasRemote: true
    }))
  const chosen = new Set(repos.map((repo) => repo.gitIdentity))
  const rows = orderProjectRepoChoices([...choices, ...elsewhere], pinned)
  const searchable = rows.length >= REPO_SEARCH_MIN_ROWS
  const needle = query.trim().toLowerCase()
  const visible =
    searchable && needle ? rows.filter((choice) => repoChoiceMatches(choice, needle)) : rows
  const openAdd = () => {
    repoIdsBeforeAdd.current = new Set(useAppStore.getState().repos.map((repo) => repo.id))
    setAddMounted(true)
    setAddOpen(true)
  }
  // Why stable: it reads refs and setters only, so the hosted controller memo stays valid.
  const absorbAddedRepos = useCallback(() => {
    const before = repoIdsBeforeAdd.current
    if (!before) {
      return
    }
    repoIdsBeforeAdd.current = null
    const added = newlyRegisteredRepos(before, useAppStore.getState().repos)
    if (added.identities.length === 0 && added.withoutRemote.length === 0) {
      return
    }
    setQuery('')
    const current = latest.current.repos
    const fresh = added.identities.filter(
      (identity) => !current.some((repo) => repo.gitIdentity === identity)
    )
    if (fresh.length > 0) {
      setPinned((prev) => new Set([...prev, ...fresh]))
      latest.current.onChange([...current, ...fresh.map((gitIdentity) => ({ gitIdentity }))])
    }
    if (added.withoutRemote.length > 0) {
      toast.warning(
        translate(
          'projects.settings.addedRepoNoRemote',
          '{{names}} added, but without a remote other computers cannot find it. Add a remote, then tick it here.',
          { names: added.withoutRemote.join(', ') }
        )
      )
    }
  }, [])
  const addController = useMemo<AddRepoDialogHostedController>(
    () => ({
      open: addOpen,
      onOpenChange: (open) => {
        setAddOpen(open)
        if (!open) {
          absorbAddedRepos()
        }
      },
      // Why: the dialog closes before this fires, so onOpenChange(false) has already absorbed.
      onProjectAdded: absorbAddedRepos,
      closeHost: closeProjectSettings
    }),
    [absorbAddedRepos, addOpen]
  )
  return (
    <section className="space-y-2" data-project-settings-repos="">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-medium">
          {translate('projects.settings.repos', 'Repos')}
          {chosen.size > 0 ? (
            <span className="ml-1.5 font-normal text-muted-foreground">
              {translate('projects.settings.reposChosen', '{{count}} chosen', {
                count: chosen.size
              })}
            </span>
          ) : null}
        </h4>
        <Button type="button" variant="ghost" size="xs" onClick={openAdd} data-project-add-repo="">
          <Plus className="size-3" />
          {translate('projects.settings.addRepo', 'Add repo…')}
        </Button>
      </div>
      {searchable ? (
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={translate('projects.settings.searchRepos', 'Search repos…')}
            aria-label={translate('projects.settings.searchRepos', 'Search repos…')}
            className="h-8 pl-7 text-xs"
          />
        </div>
      ) : null}
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'projects.settings.noRepos',
            'No repos are registered on this computer. Use Add repo… to register one from a folder, a clone URL, or an SSH host.'
          )}
        </p>
      ) : visible.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {translate('projects.settings.noReposMatch', 'No repos match “{{query}}”.', {
            query: query.trim()
          })}
        </p>
      ) : (
        <ul className="max-h-48 space-y-1 overflow-y-auto scrollbar-sleek">
          {visible.map((choice) => {
            const checked = chosen.has(choice.gitIdentity)
            return (
              <li key={choice.gitIdentity}>
                <label
                  className="flex min-w-0 items-center gap-2 rounded px-1 py-0.5 text-xs"
                  data-project-repo={choice.gitIdentity}
                >
                  <Checkbox
                    checked={checked}
                    disabled={!choice.hasRemote}
                    onCheckedChange={() =>
                      onChange(
                        checked
                          ? repos.filter((repo) => repo.gitIdentity !== choice.gitIdentity)
                          : [...repos, { gitIdentity: choice.gitIdentity }]
                      )
                    }
                  />
                  <span className="min-w-0 truncate font-medium">{choice.label}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {choice.hasRemote
                      ? choice.gitIdentity
                      : translate(
                          'projects.settings.repoNoRemote',
                          'No remote: it cannot be found on other computers. Add a remote first.'
                        )}
                  </span>
                </label>
              </li>
            )
          })}
        </ul>
      )}
      {addMounted ? (
        <Suspense fallback={null}>
          <HostedAddRepoDialog hosted={addController} />
        </Suspense>
      ) : null}
    </section>
  )
}
