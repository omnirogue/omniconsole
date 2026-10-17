import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import {
  WORKFLOW_CHECK_DEFAULT_SECONDS,
  type WorkflowCheck
} from '../../../../shared/workflow-graph'
import { WorkflowImproveCodeFields, workflowImproveTestWarning } from './WorkflowImproveCodeFields'
import { WorkflowImproveSealedFields } from './WorkflowImproveSealedFields'
import { WorkflowSelect } from './workflow-graph-controls'

const TIME_LIMITS = [30, 60, 180, 300, 600, 1800]

function timeLabel(seconds: number): string {
  return seconds < 60
    ? translate('workflowGraph.improve.test.seconds', '{{count}} s', { count: seconds })
    : translate('workflowGraph.improve.test.minutes', '{{count}} min', { count: seconds / 60 })
}

/** The options summary's words for the test: that versions are tested, and on how many cases. */
export function workflowImproveTestSummary(check: WorkflowCheck | undefined): string[] {
  const practice = check?.cases?.filter((line) => line.trim()).length ?? 0
  const kept = check?.sealed?.cases?.filter((line) => line.trim()).length ?? 0
  return [
    ...(check ? [translate('workflowGraph.improve.checkSummary', 'checked')] : []),
    ...(check?.apply === 'patch'
      ? [translate('workflowGraph.improve.test.kindSummary', 'changes to this code')]
      : []),
    ...(practice
      ? [
          translate('workflowGraph.improve.test.casesSummary', 'practice cases: {{count}}', {
            count: practice
          })
        ]
      : []),
    ...(check?.sealed
      ? [
          kept
            ? translate('workflowGraph.improve.test.sealedSummary', 'kept back: {{count}}', {
                count: kept
              })
            : translate('workflowGraph.improve.test.sealedCommandSummary', 'final test kept back')
        ]
      : [])
  ]
}

function TestField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="col-span-2 flex flex-col gap-1 text-xs font-medium text-muted-foreground">
      {label}
      {children}
    </label>
  )
}

/**
 * How Improve tests each version: the person's own command, practice cases it runs once each,
 * and a time limit per run. Only the person sets these; no model ever adds or changes a test.
 */
export function WorkflowImproveTestFields({
  check,
  onChange
}: {
  check: WorkflowCheck | undefined
  onChange: (check: WorkflowCheck | undefined) => void
}) {
  // Typed as is (blank lines too); the workflow is cleaned when it is read.
  const patch = (change: Partial<WorkflowCheck>) =>
    onChange(
      Object.fromEntries(
        Object.entries({ ...check!, ...change }).filter(([, value]) => value !== undefined)
      ) as WorkflowCheck
    )
  const timeLimit = check?.timeoutSeconds ?? WORKFLOW_CHECK_DEFAULT_SECONDS
  const limits = TIME_LIMITS.includes(timeLimit) ? TIME_LIMITS : [...TIME_LIMITS, timeLimit]
  return (
    <>
      <TestField
        label={translate(
          'workflowGraph.improve.test.command',
          'How to test each version (optional)'
        )}
      >
        <Input
          className="h-8 font-mono text-xs"
          value={check?.command ?? ''}
          placeholder={translate('workflowGraph.improve.test.commandPlaceholder', 'e.g. pnpm test')}
          onChange={(event) =>
            event.target.value.trim()
              ? check
                ? patch({ command: event.target.value })
                : onChange({ command: event.target.value })
              : onChange(undefined)
          }
        />
        <span className="font-normal">
          {check?.apply === 'patch'
            ? translate(
                'workflowGraph.improve.test.commandHintCode',
                'Runs in a private copy of this repository with the version\'s change applied, without a shell and without this app\'s keys. Exit 0 passes. When the last line printed is "SCORE: <number>", it ranks, and passing and a higher score beat any judge.'
              )
            : translate(
                'workflowGraph.improve.test.commandHint',
                'Runs in this workspace on every version, without a shell and without this app\'s keys. Exit 0 passes. When the last line printed is "SCORE: <number>", it ranks, and passing and a higher score beat any judge. {candidate} is the version as a file, {code} its code.'
              )}
        </span>
        <span className="font-normal text-status-warning">{workflowImproveTestWarning()}</span>
      </TestField>
      {check ? (
        <>
          <WorkflowImproveCodeFields check={check} onChange={patch} />
          <TestField
            label={translate(
              'workflowGraph.improve.test.cases',
              'Practice cases (optional, one per line)'
            )}
          >
            <Textarea
              rows={3}
              className="font-mono text-xs"
              value={check.cases?.join('\n') ?? ''}
              onChange={(event) => {
                const lines = event.target.value.split('\n')
                patch({ cases: lines.some((line) => line.trim()) ? lines : undefined })
              }}
            />
            <span className="font-normal">
              {translate(
                'workflowGraph.improve.test.casesHint',
                'Each version is tested on every line. The line replaces {case} in the command.'
              )}
            </span>
          </TestField>
          <WorkflowImproveSealedFields check={check} onChange={patch} />
          <TestField
            label={translate('workflowGraph.improve.test.timeLimit', 'Time limit per test')}
          >
            <WorkflowSelect
              value={String(timeLimit)}
              options={limits.map((seconds) => ({
                value: String(seconds),
                label: timeLabel(seconds)
              }))}
              onChange={(value) => {
                const seconds = Number(value)
                patch({
                  timeoutSeconds: seconds === WORKFLOW_CHECK_DEFAULT_SECONDS ? undefined : seconds
                })
              }}
            />
          </TestField>
          <span className="col-span-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Checkbox
              checked={Boolean(check.predict)}
              onCheckedChange={(checked) => patch({ predict: checked === true ? true : undefined })}
              aria-label={translate(
                'workflowGraph.improve.test.predict',
                'Each version is a hypothesis: it must predict the result first'
              )}
            />
            {translate(
              'workflowGraph.improve.test.predict',
              'Each version is a hypothesis: it must predict the result first'
            )}
          </span>
          <span className="col-span-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Checkbox
              checked={Boolean(check.stopWhenPassing)}
              onCheckedChange={(checked) =>
                patch({ stopWhenPassing: checked === true ? true : undefined })
              }
              aria-label={translate(
                'workflowGraph.improve.test.stopWhenPassing',
                'Stop as soon as a version passes'
              )}
            />
            {translate(
              'workflowGraph.improve.test.stopWhenPassing',
              'Stop as soon as a version passes'
            )}
          </span>
        </>
      ) : null}
    </>
  )
}
