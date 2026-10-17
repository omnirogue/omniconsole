import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'
import {
  WORKFLOW_FIND_HARVEST_DEFAULT,
  WORKFLOW_FIND_HARVEST_MAX,
  WORKFLOW_FIND_HARVEST_MAX_QUERY_CHARS,
  type WorkflowFind
} from '../../../../shared/workflow-graph'

/**
 * Search GitHub: the person's own search, whose repositories join the pool as candidates. The
 * help text says plainly what the judges are given, because the owner's description is the one
 * thing a repository could word at them, and it is never used.
 */
export function WorkflowFindGitHubSearch({
  harvest,
  onChange
}: {
  harvest: WorkflowFind['harvest']
  onChange: (harvest: WorkflowFind['harvest'] | null) => void
}) {
  const max = harvest?.max ?? WORKFLOW_FIND_HARVEST_DEFAULT
  return (
    <div className="col-span-2 grid grid-cols-[1fr_auto] gap-3">
      <div className="space-y-1">
        <Label htmlFor="find-github-query" className="text-xs font-medium text-muted-foreground">
          {translate('workflowGraph.find.githubSearch', 'Search GitHub (optional)')}
        </Label>
        <Input
          id="find-github-query"
          className="h-8 text-xs"
          maxLength={WORKFLOW_FIND_HARVEST_MAX_QUERY_CHARS}
          value={harvest?.query ?? ''}
          placeholder={translate(
            'workflowGraph.find.githubSearchPlaceholder',
            'e.g. job queue language:go stars:>500'
          )}
          onChange={(event) =>
            onChange(event.target.value ? { query: event.target.value, max } : null)
          }
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="find-github-max" className="text-xs font-medium text-muted-foreground">
          {translate('workflowGraph.find.githubHowMany', 'How many')}
        </Label>
        <Input
          id="find-github-max"
          type="number"
          min={1}
          max={WORKFLOW_FIND_HARVEST_MAX}
          className="h-8 w-20 text-xs"
          value={String(max)}
          disabled={!harvest}
          onChange={(event) => harvest && onChange({ ...harvest, max: Number(event.target.value) })}
        />
      </div>
      <p className="col-span-2 -mt-1 text-xs font-normal text-muted-foreground">
        {translate(
          'workflowGraph.find.githubSearchHint',
          "Searches GitHub's public repositories. Only the name, stars, activity, language and licence are used: never the owner's description."
        )}
      </p>
    </div>
  )
}
