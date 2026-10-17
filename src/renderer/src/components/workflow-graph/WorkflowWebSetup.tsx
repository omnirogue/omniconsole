import { useId } from 'react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import type { WorkflowSpec } from '../../../../shared/workflow-graph'
import { workflowWebRefusal } from '../../../../shared/workflow-web-pages'
import {
  withSetupPages,
  withWebScreenRubric,
  workflowWebPrefill,
  workflowWebRequestPages,
  workflowWebScreenRubric,
  workflowWebSetup
} from '../../../../shared/workflow-web-setup'
import { workflowWebRefusalLabel } from './web-page-reason-label'
import { WorkflowWebPagesField } from './WorkflowWebPagesField'

function RubricChoice({
  spec,
  onChange
}: {
  spec: WorkflowSpec
  onChange: (spec: WorkflowSpec) => void
}) {
  const rubric = workflowWebScreenRubric(spec)
  const switchId = useId()
  if (!rubric) {
    return null
  }
  const generic = rubric === 'generic'
  const text = typeof rubric === 'object' ? rubric.text : ''
  return (
    <div
      className="space-y-1.5 rounded-md border border-status-warning-border bg-status-warning/5 p-2"
      data-workflow-web-rubric={typeof rubric === 'object' ? 'written' : rubric}
    >
      <p className="text-xs font-medium">
        {translate('workflowGraph.web.setup.rubricTitle', 'Reading pages needs a written rubric')}
      </p>
      <p className="text-xs text-muted-foreground">
        {translate(
          'workflowGraph.web.setup.rubricWhy',
          'Discover normally scores each finding by a rubric a model writes from its brief, and a page could steer that. With pages, use the generic rubric or write your own.'
        )}
      </p>
      <label htmlFor={switchId} className="flex items-center gap-2 text-xs">
        <Switch
          id={switchId}
          checked={generic}
          onCheckedChange={(checked) =>
            onChange(withWebScreenRubric(spec, checked ? 'generic' : 'model'))
          }
        />
        {translate('workflowGraph.web.setup.generic', 'Use the generic rubric')}
      </label>
      <Textarea
        rows={3}
        value={text}
        disabled={generic}
        aria-label={translate('workflowGraph.web.setup.written', 'Your rubric')}
        placeholder={translate(
          'workflowGraph.web.setup.writtenPlaceholder',
          'Or write your own: one question per line, such as "Does it quote the page it relies on?"'
        )}
        onChange={(event) => onChange(withWebScreenRubric(spec, { text: event.target.value }))}
      />
    </div>
  )
}

/**
 * Setup's "Pages to read" for the workflows that read them first: the request's addresses are
 * offered, each removable; nothing is fetched until Start.
 */
export function WorkflowWebSetup({
  spec,
  prompt,
  dismissed,
  onDismiss,
  onChange
}: {
  spec: WorkflowSpec
  prompt: string
  dismissed: ReadonlySet<string>
  onDismiss: (urls: string[]) => void
  onChange: (spec: WorkflowSpec) => void
}) {
  const setup = workflowWebSetup(spec)
  if (!setup) {
    return null
  }
  if (setup.kind === 'decide') {
    return (
      <p role="note" className="rounded-xl border bg-card p-3 text-xs text-muted-foreground">
        {translate(
          'workflowGraph.web.setup.decide',
          'Decide can’t read web pages yet. It compares the options by a rubric its first step writes, and a workflow that reads pages may only use a rubric you write.'
        )}
      </p>
    )
  }
  const urls = spec.steps.find((step) => step.id === setup.stepId)?.web?.urls ?? []
  const refusal = workflowWebRefusal(spec, setup.stepId, { ignoreRubric: true })
  const offered = workflowWebRequestPages(spec, prompt, dismissed)
  return (
    <section
      className="space-y-2 rounded-xl border bg-card p-3"
      data-workflow-web-setup={setup.stepId}
    >
      <WorkflowWebPagesField
        urls={urls}
        others={spec.steps.flatMap((step) =>
          step.id === setup.stepId ? [] : (step.web?.urls ?? [])
        )}
        refusal={refusal ? workflowWebRefusalLabel(refusal) : undefined}
        onChange={(next) => {
          const kept = new Set(next)
          onDismiss(urls.filter((url) => !kept.has(url)))
          onChange(withSetupPages(spec, setup.stepId, next))
        }}
      />
      {offered.length > 0 && (
        <Button
          type="button"
          variant="link"
          size="xs"
          className="px-0"
          onClick={() => {
            const next = workflowWebPrefill(spec, prompt, dismissed)
            if (next) {
              onChange(next)
            }
          }}
        >
          {offered.length === 1
            ? translate(
                'workflowGraph.web.setup.fromRequestOne',
                'Add the address from your request'
              )
            : translate(
                'workflowGraph.web.setup.fromRequest',
                'Add {{count}} addresses from your request',
                {
                  count: offered.length
                }
              )}
        </Button>
      )}
      {urls.length > 0 && setup.screenStepId ? (
        <RubricChoice spec={spec} onChange={onChange} />
      ) : null}
    </section>
  )
}
