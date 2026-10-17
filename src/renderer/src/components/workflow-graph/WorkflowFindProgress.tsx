import { AlertTriangle, Crown, FolderOpen, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { WorkflowFindSaved, WorkflowFindTrail } from '../../../../shared/workflow-find-trail'

function stageLine(trail: WorkflowFindTrail): string {
  switch (trail.stage) {
    case 'options':
      return translate('workflowGraph.find.stageOptions', 'Coming up with options…')
    case 'check':
      return translate('workflowGraph.find.stageCheck', 'Your check runs on {{count}} versions…', {
        count: trail.pool
      })
    case 'facts':
      return translate(
        'workflowGraph.find.stageFacts',
        'Fetching GitHub facts for {{count}} repositories…',
        {
          count: trail.facts?.repos ?? trail.pool
        }
      )
    case 'screen':
      return translate('workflowGraph.find.stageScreen', 'JEV is scoring {{count}} options…', {
        count: trail.pool
      })
    case 'final':
      return translate('workflowGraph.find.stageFinal', 'The top {{count}} meet head to head…', {
        count: trail.overall.length
      })
    case 'done':
      return translate('workflowGraph.find.stageDone', 'Best of {{count}}: {{title}}', {
        count: trail.pool,
        title: trail.winner?.title ?? ''
      })
    case 'failed':
      return trail.reason ?? translate('workflowGraph.find.stageFailed', 'Find the best stopped.')
  }
}

const fileName = (path: string) => path.split(/[\\/]/).at(-1) ?? path

/** Where the results files went, with a way to open them, or why they could not be written. */
function SavedLine({ saved }: { saved: WorkflowFindSaved }) {
  if ('error' in saved) {
    return (
      <p role="alert" className="text-status-warning">
        {translate('workflowGraph.find.saveFailed', 'Could not save the results files: {{error}}', {
          error: saved.error
        })}
      </p>
    )
  }
  const [first, ...others] = saved.files.map(fileName)
  const reveal = async () => {
    const result = await window.api.shell.openInFileManager(saved.files[0] ?? saved.folder)
    if (!result.ok) {
      toast.error(translate('workflowGraph.find.revealFailed', 'Could not show the results files.'))
    }
  }
  return (
    <p className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
      <span className="break-all">
        {translate('workflowGraph.find.saved', 'Every option and score is saved: {{files}}', {
          files: [first, ...others.map((name) => name.slice(name.lastIndexOf('.')))].join(' and ')
        })}
      </span>
      <Button
        type="button"
        variant="link"
        size="xs"
        className="h-auto gap-1 px-0"
        onClick={() => void reveal()}
      >
        <FolderOpen aria-hidden="true" className="size-3" />
        {translate('workflowGraph.find.showInFolder', 'Show in folder')}
      </Button>
    </p>
  )
}

/** Where a Find the best run stands, in one line; the report below has the lists. */
export function WorkflowFindProgress({
  trail,
  running
}: {
  trail: WorkflowFindTrail
  running: boolean
}) {
  const Icon =
    trail.stage === 'failed'
      ? AlertTriangle
      : trail.stage === 'done'
        ? Crown
        : running
          ? Loader2
          : Crown
  return (
    <section
      aria-label={translate('workflowGraph.find.progress', 'Find the best')}
      className="space-y-1 rounded-lg border bg-card p-3 text-xs"
    >
      <p className="flex items-center gap-1.5 font-medium">
        <Icon
          aria-hidden="true"
          className={
            trail.stage === 'failed'
              ? 'size-3.5 text-status-warning'
              : running && trail.stage !== 'done'
                ? 'size-3.5 animate-spin'
                : 'size-3.5'
          }
        />
        {stageLine(trail)}
      </p>
      {trail.scored !== undefined ? (
        <p className="text-muted-foreground">
          {translate(
            'workflowGraph.find.scored',
            'JEV scored {{scored}} of {{pool}} options{{unscored}}.',
            {
              scored: trail.scored,
              pool: trail.pool,
              unscored: trail.unscored
                ? translate('workflowGraph.find.unscored', '; {{count}} could not be scored', {
                    count: trail.unscored
                  })
                : ''
            }
          )}
        </p>
      ) : null}
      {trail.saved ? <SavedLine saved={trail.saved} /> : null}
    </section>
  )
}
