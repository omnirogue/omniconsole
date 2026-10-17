import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { WorkflowCheck } from '../../../../shared/workflow-graph'
import { useWorkflowWorkspaceIsFolder } from './workflow-workspace-kind-context'

type CheckChange = Partial<Pick<WorkflowCheck, 'apply' | 'prepare' | 'protect'>>

/** The warning every test shows: honest about where it runs, and never called a sandbox. */
export function workflowImproveTestWarning(): string {
  return translate(
    'workflowGraph.improve.test.warning',
    'Tests run on this computer, as you, and may run code the AIs wrote. A change to your code is tested in a private copy, never in your files.'
  )
}

/**
 * What each version is: text (a draft, a prompt, a function) or a change to this code. A change
 * is tested in a private copy of the repository, got ready once with the person's command, and
 * may never touch the files the person protects. Only the person sets these.
 */
export function WorkflowImproveCodeFields({
  check,
  onChange
}: {
  check: WorkflowCheck
  onChange: (change: CheckChange) => void
}) {
  const code = check.apply === 'patch'
  const folder = useWorkflowWorkspaceIsFolder()
  const label = translate('workflowGraph.improve.test.kind', 'What is each version?')
  return (
    <>
      <div className="col-span-2 flex flex-col gap-1 text-xs font-medium text-muted-foreground">
        <span>{label}</span>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          aria-label={label}
          value={code ? 'patch' : 'text'}
          onValueChange={(value) => {
            if (value === 'patch') {
              onChange({ apply: 'patch' })
            } else if (value === 'text') {
              onChange({ apply: undefined, prepare: undefined, protect: undefined })
            }
          }}
        >
          <ToggleGroupItem value="text" className="text-xs">
            {translate(
              'workflowGraph.improve.test.kindText',
              'Text (a draft, a prompt, a function)'
            )}
          </ToggleGroupItem>
          <ToggleGroupItem value="patch" className="text-xs" disabled={folder}>
            {translate('workflowGraph.improve.test.kindCode', 'A change to this code')}
          </ToggleGroupItem>
        </ToggleGroup>
        {folder ? (
          <span className={cn('font-normal', code && 'text-status-warning')}>
            {translate(
              'workflowGraph.improve.test.kindCodeFolder',
              'A change to this code needs a Git repository, and this workspace is a plain folder.'
            )}
          </span>
        ) : code ? (
          <span className="font-normal">
            {translate(
              'workflowGraph.improve.test.kindCodeHint',
              'Each version is a diff, tested in a private copy of your last commit. Needs a Git repository with nothing uncommitted.'
            )}
          </span>
        ) : null}
      </div>
      {code ? (
        <>
          <label className="col-span-2 flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            {translate('workflowGraph.improve.test.prepare', 'Get ready first (optional)')}
            <Input
              className="h-8 font-mono text-xs"
              value={check.prepare ?? ''}
              placeholder={translate(
                'workflowGraph.improve.test.preparePlaceholder',
                'e.g. pnpm install'
              )}
              onChange={(event) =>
                onChange({ prepare: event.target.value.trim() ? event.target.value : undefined })
              }
            />
            <span className="font-normal">
              {translate(
                'workflowGraph.improve.test.prepareHint',
                'Runs once in each private copy before its first test, for example to install dependencies.'
              )}
            </span>
          </label>
          <label className="col-span-2 flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            {translate('workflowGraph.improve.test.protect', 'Files the AI may not change')}
            <Textarea
              rows={2}
              className="font-mono text-xs"
              value={check.protect?.join('\n') ?? ''}
              placeholder={translate(
                'workflowGraph.improve.test.protectPlaceholder',
                'e.g. tests/**'
              )}
              onChange={(event) => {
                const lines = event.target.value.split('\n')
                onChange({ protect: lines.some((line) => line.trim()) ? lines : undefined })
              }}
            />
            <span className="font-normal">
              {translate(
                'workflowGraph.improve.test.protectHint',
                'One pattern per line, as in .gitignore. A change that touches one of them fails its test.'
              )}
            </span>
          </label>
        </>
      ) : null}
    </>
  )
}
