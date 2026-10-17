import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import type { WorkflowCheck, WorkflowSealedCheck } from '../../../../shared/workflow-graph'

type SealedChange = Partial<Pick<WorkflowCheck, 'cases' | 'sealed'>>

const filled = (lines: readonly string[] | undefined) => (lines ?? []).filter((line) => line.trim())

/** Practice lines 3, 6, 9… move to the kept-back cases: the same split every time, never random. */
export function workflowKeepBackEveryThird(check: WorkflowCheck): SealedChange {
  const practice = filled(check.cases)
  const kept = practice.filter((_, index) => index % 3 === 2)
  const left = practice.filter((_, index) => index % 3 !== 2)
  return {
    cases: left.length ? left : undefined,
    sealed: { ...check.sealed, cases: [...filled(check.sealed?.cases), ...kept] }
  }
}

/** The final test, kept back: only the person fills it in, and no AI is ever shown it. */
export function WorkflowImproveSealedFields({
  check,
  onChange
}: {
  check: WorkflowCheck
  onChange: (change: SealedChange) => void
}) {
  // Typed as is (blank lines too); the workflow is cleaned when it is read.
  const setSealed = (change: Partial<WorkflowSealedCheck>) => {
    const next = Object.fromEntries(
      Object.entries({ ...check.sealed, ...change }).filter(([, value]) => value !== undefined)
    ) as WorkflowSealedCheck
    onChange({ sealed: Object.keys(next).length ? next : undefined })
  }
  return (
    <div className="col-span-2 flex flex-col gap-1 text-xs font-medium text-muted-foreground">
      <span>
        {translate('workflowGraph.improve.test.sealed', 'Final test, kept back (optional)')}
      </span>
      <span className="font-normal">
        {translate(
          'workflowGraph.improve.test.sealedHint',
          'Cases or a command the AIs never see. Run once at the end to check the winner really beats what you started with.'
        )}
      </span>
      <Input
        className="h-8 font-mono text-xs"
        aria-label={translate('workflowGraph.improve.test.sealedCommand', 'Final test command')}
        value={check.sealed?.command ?? ''}
        placeholder={translate(
          'workflowGraph.improve.test.sealedCommandPlaceholder',
          'Same as the test command'
        )}
        onChange={(event) =>
          setSealed({ command: event.target.value.trim() ? event.target.value : undefined })
        }
      />
      <Textarea
        rows={2}
        className="font-mono text-xs"
        aria-label={translate(
          'workflowGraph.improve.test.sealedCases',
          'Kept-back cases, one per line'
        )}
        placeholder={translate(
          'workflowGraph.improve.test.sealedCases',
          'Kept-back cases, one per line'
        )}
        value={check.sealed?.cases?.join('\n') ?? ''}
        onChange={(event) => {
          const lines = event.target.value.split('\n')
          setSealed({ cases: lines.some((line) => line.trim()) ? lines : undefined })
        }}
      />
      <span className="flex flex-wrap items-center gap-2 font-normal">
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={filled(check.cases).length < 3}
          onClick={() => onChange(workflowKeepBackEveryThird(check))}
        >
          {translate('workflowGraph.improve.test.sealedKeepBack', 'Keep back every third case')}
        </Button>
        {translate(
          'workflowGraph.improve.test.sealedFiles',
          'Keep the final-test files outside the workspace if the AIs must not be able to read them.'
        )}
      </span>
    </div>
  )
}
