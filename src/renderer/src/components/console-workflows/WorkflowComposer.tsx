import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { newWorkflowStage, type WorkflowDraft } from '@/lib/console-workflow-draft'
import { useWorkflowComposer } from './use-workflow-composer'
import { WorkflowError, WorkflowSelect, WorkflowTextField } from './WorkflowFields'
import { WorkflowStageEditor } from './WorkflowStageEditor'
import { WorkflowPreviewPanel } from './WorkflowPreviewPanel'
import { WorkflowAdmissionFields } from './WorkflowAdmissionFields'

export function WorkflowComposer({
  initialTaskId,
  onAdmitted,
  initialDraft
}: {
  initialTaskId: string | null
  onAdmitted: (workflowId: string) => void
  /** Stages handed over from another surface; the person still previews and approves here. */
  initialDraft?: WorkflowDraft
}) {
  const composer = useWorkflowComposer(initialTaskId, onAdmitted, initialDraft)
  const { draft, update, pending } = composer
  const canPreview =
    draft.taskId.trim() &&
    draft.title.trim() &&
    draft.company.trim() &&
    draft.prompt.trim() &&
    draft.stages.every((stage) => stage.title.trim() && stage.prompt.trim()) &&
    (!draft.stages.some((stage) => stage.actorType === 'ai') || draft.repo.trim()) &&
    Object.values(draft.admission).every((value) => value.trim())
  const addStage = () => {
    let index = draft.stages.length + 1
    const previous = draft.stages.at(-1)
    while (draft.stages.some((stage) => stage.key === `stage-${index}`)) {
      index++
    }
    update({
      ...draft,
      stages: [...draft.stages, newWorkflowStage(`stage-${index}`, previous ? [previous.key] : [])]
    })
  }
  return (
    <section className="space-y-4">
      <h2 className="text-sm font-medium">
        {translate('consoleWorkflows.compose', 'Compose workflow')}
      </h2>
      <p className="text-xs text-muted-foreground">
        {translate(
          'consoleWorkflows.draftLifetime',
          'Stages run in order. This draft lasts while this page is open. Preview and approve it before starting any job.'
        )}
      </p>
      {!!composer.catalogErrors.length && (
        <details open className="space-y-2">
          <summary className="cursor-pointer text-sm text-muted-foreground">
            {translate(
              'consoleWorkflows.catalogUnavailable',
              'Some server catalogs are unavailable'
            )}
          </summary>
          {[...new Set(composer.catalogErrors)].map((error) => (
            <WorkflowError key={error} message={error} />
          ))}
        </details>
      )}
      <fieldset disabled={pending} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <WorkflowTextField
            label={translate('consoleWorkflows.existingTask', 'Existing task ID')}
            value={draft.taskId}
            onChange={(taskId) => update({ ...draft, taskId })}
          />
          <WorkflowTextField
            label={translate('consoleWorkflows.company', 'Company slug')}
            value={draft.company}
            onChange={(company) => update({ ...draft, company })}
          />
        </div>
        <WorkflowTextField
          label={translate('consoleWorkflows.repositoryOwnerName', 'Repository (owner/name)')}
          value={draft.repo}
          onChange={(repo) => update({ ...draft, repo })}
        />
        <WorkflowTextField
          label={translate('consoleWorkflows.title', 'Workflow title')}
          value={draft.title}
          onChange={(title) => update({ ...draft, title })}
        />
        <WorkflowTextField
          label={translate('consoleWorkflows.prompt', 'Workflow prompt')}
          value={draft.prompt}
          onChange={(prompt) => update({ ...draft, prompt })}
          multiline
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <WorkflowSelect
            label={translate('consoleWorkflows.placement', 'Workflow placement')}
            value={draft.placement}
            onChange={(placement) =>
              update({ ...draft, placement: placement as 'local' | 'fleet' })
            }
            options={[
              { value: 'local', label: translate('consoleWorkflows.local', 'Local') },
              { value: 'fleet', label: translate('consoleWorkflows.fleet', 'Fleet') }
            ]}
          />
        </div>
        <WorkflowAdmissionFields
          draft={draft.admission}
          stages={draft.stages}
          onChange={(admission) => update({ ...draft, admission })}
        />
        {draft.stages.map((stage) => (
          <WorkflowStageEditor
            key={stage.key}
            stage={stage}
            stages={draft.stages}
            inventory={composer.inventory}
            disabled={pending}
            onChange={(next) =>
              update({
                ...draft,
                stages: draft.stages.map((item) => (item.key === stage.key ? next : item))
              })
            }
            onRemove={() =>
              update({
                ...draft,
                stages: draft.stages.filter((item) => item.key !== stage.key)
              })
            }
          />
        ))}
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={pending || draft.stages.length >= 64}
            onClick={addStage}
          >
            <Plus />
            {translate('consoleWorkflows.addStage', 'Add stage')}
          </Button>
          <Button disabled={pending || !canPreview} onClick={composer.previewDraft}>
            {translate('consoleWorkflows.preview', 'Preview workflow')}
          </Button>
        </div>
      </fieldset>
      <WorkflowError message={composer.error} />
      {composer.preview && (
        <WorkflowPreviewPanel
          key={composer.preview.result.digest}
          preview={composer.preview.result}
          admission={composer.preview.admission}
          taskId={composer.preview.taskId}
          revision={composer.preview.revision}
          consent={composer.consent}
          onConsent={composer.setConsent}
          onApprove={composer.approve}
          pending={pending}
        />
      )}
    </section>
  )
}
