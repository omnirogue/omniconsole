import { useRef, useState } from 'react'
import { Loader2, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import type { WorkflowRoute, WorkflowSpec } from '../../../../shared/workflow-graph'
import type { WorkflowCompileModels } from '../../../../shared/workflow-graph-compile'
import { describeWorkflow } from '../../../../shared/workflow-graph-topology'
import { useWorkflowCompile } from './use-workflow-compile'

type TurnBody =
  | { role: 'you'; text: string }
  | { role: 'workflow'; lines: string[]; assumptions: string[]; problems: string[] }
  | { role: 'error'; text: string }
type Turn = TurnBody & { id: number }

/**
 * Describe a workflow in plain words; the first message builds it, later ones change it. What
 * comes back is shown as the graph and read back in sentences, with every assumption named.
 */
export function WorkflowDescribePanel({
  worktreeId,
  spec,
  available,
  models,
  onCompiled
}: {
  worktreeId: string
  /** The workflow being edited; empty until the first description. */
  spec?: WorkflowSpec
  available: readonly WorkflowRoute[]
  /** The person's tier lineups: "cheap researchers, a frontier synthesizer" resolves to them. */
  models?: WorkflowCompileModels
  onCompiled: (spec: WorkflowSpec, task: string) => void
}) {
  const { compile, compiling, cancel } = useWorkflowCompile(worktreeId)
  const [text, setText] = useState('')
  const [turns, setTurns] = useState<Turn[]>([])
  const nextId = useRef(0)
  const turn = (entry: TurnBody): Turn => ({ ...entry, id: nextId.current++ })
  const submit = async () => {
    const description = text.trim()
    if (!description || compiling) {
      return
    }
    setText('')
    const added = turn({ role: 'you', text: description })
    setTurns((current) => [...current, added])
    const result = await compile({
      description,
      ...(spec?.steps.length ? { current: spec } : {}),
      available,
      ...(models ? { models } : {})
    })
    if ('error' in result) {
      const added = turn({ role: 'error', text: result.error })
      setTurns((current) => [...current, added])
      return
    }
    onCompiled(result.spec, result.task)
    const described = turn({
      role: 'workflow',
      lines: describeWorkflow(result.spec),
      assumptions: result.assumptions,
      problems: result.validation.problems.map((problem) => problem.message)
    })
    setTurns((current) => [...current, described])
  }
  return (
    <section
      aria-label={translate('workflowGraph.describe.label', 'Describe the workflow')}
      className="space-y-3 rounded-xl border bg-card p-3"
    >
      {turns.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {translate(
            'workflowGraph.describe.intro',
            'Say who works in parallel, who reviews or ranks what, and who writes the final answer. For example: “Have 4 agents independently research this, send their findings to 2 critics, then have one synthesizer produce the final answer using the research and criticism.”'
          )}
        </p>
      )}
      {turns.map((entry) =>
        entry.role === 'you' ? (
          <div key={entry.id} className="flex justify-end">
            <p className="max-w-[85%] whitespace-pre-wrap rounded-lg rounded-tr-sm bg-muted px-3 py-2 text-sm">
              {entry.text}
            </p>
          </div>
        ) : entry.role === 'error' ? (
          <p key={entry.id} role="alert" className="text-sm text-destructive">
            {entry.text}
          </p>
        ) : (
          <div key={entry.id} className="space-y-1.5 text-sm">
            <ul className="list-disc space-y-0.5 pl-5">
              {entry.lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            {entry.assumptions.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {translate('workflowGraph.describe.assumed', 'Assumed: {{list}}', {
                  list: entry.assumptions.join(' ')
                })}
              </p>
            )}
            {entry.problems.length > 0 && (
              <p className="text-xs text-destructive">
                {translate(
                  'workflowGraph.describe.stillInvalid',
                  'Not runnable yet; fix the marked steps below or describe the change.'
                )}
              </p>
            )}
          </div>
        )
      )}
      <div className="flex items-end gap-2">
        <Textarea
          rows={2}
          value={text}
          disabled={compiling}
          aria-label={translate('workflowGraph.describe.input', 'Workflow description')}
          placeholder={
            spec?.steps.length
              ? translate(
                  'workflowGraph.describe.change',
                  'Describe a change, e.g. “make the critics GPT and Grok” or “cheap models for the research”'
                )
              : translate('workflowGraph.describe.placeholder', 'Describe the workflow…')
          }
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void submit()
            }
          }}
        />
        {compiling ? (
          <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={cancel}>
            <Loader2 className="size-3.5 animate-spin" />
            {translate('workflowGraph.describe.stop', 'Stop')}
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            className="gap-1.5"
            disabled={!text.trim()}
            onClick={() => void submit()}
          >
            <Sparkles className="size-3.5" />
            {spec?.steps.length
              ? translate('workflowGraph.describe.update', 'Update')
              : translate('workflowGraph.describe.build', 'Build')}
          </Button>
        )}
      </div>
    </section>
  )
}
