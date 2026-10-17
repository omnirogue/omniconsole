import { automationRepositoryContext } from './automation-repository-selection'
import type { Repo } from '../../../../shared/repo-types'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import AutomationProjectCombobox from './AutomationProjectCombobox'
import type { AutomationDraft } from './AutomationEditorDialog'

export function AutomationRepositoryFields({
  draft,
  repos,
  onDraftChange,
  onProjectChange
}: {
  draft: AutomationDraft
  repos: readonly Repo[]
  onDraftChange: (update: (current: AutomationDraft) => AutomationDraft) => void
  onProjectChange: (id: string) => void
}) {
  const add = (id: string) => {
    const repo = repos.find((row) => row.id === id)
    if (!repo) {
      return
    }
    if (draft.repos?.some((entry) => entry.repoId === id)) {
      return
    }
    const context = automationRepositoryContext(repo)
    if (!context) {
      return
    }
    if (!draft.repos?.length) {
      onProjectChange(id)
    }
    onDraftChange((current) => ({
      ...current,
      repos: [...(current.repos ?? []).filter((row) => row.repoId !== id), context]
    }))
  }
  return (
    <section className="space-y-2" data-routine-repositories>
      <Label>{translate('routines.definition.repositories', 'Repositories')}</Label>
      <AutomationProjectCombobox
        repos={repos}
        value=""
        onValueChange={add}
        allowAddProject={false}
        placeholder={translate('routines.definition.selectRepository', 'Select a repository')}
      />
      {draft.repos?.map((repo, index) => (
        <div key={`${repo.hostId}:${repo.repoId}`} className="flex items-center gap-2 text-xs">
          <span className="min-w-0 flex-1 truncate">{repo.path}</span>
          <span className="text-muted-foreground">
            {index === 0
              ? translate('routines.definition.runWorkspace', 'Run workspace')
              : translate('routines.definition.readOnly', 'Read-only context')}
          </span>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              const next = draft.repos?.filter((entry) => entry !== repo) ?? []
              if (index === 0 && next[0]) {
                onProjectChange(next[0].repoId)
              }
              onDraftChange((current) => ({
                ...current,
                repos: next,
                ...(!next.length ? { projectId: '', workspaceId: '' } : {})
              }))
            }}
          >
            {translate('routines.definition.remove', 'Remove')}
          </Button>
        </div>
      ))}
      {draft.repositoryRequired && !draft.repos?.length ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'routines.definition.repositoryRequired',
            'Select a repository before creating this routine.'
          )}
        </p>
      ) : null}
    </section>
  )
}
