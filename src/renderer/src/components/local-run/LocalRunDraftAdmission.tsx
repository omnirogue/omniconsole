import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { WorkflowDraft } from '@/lib/console-workflow-draft'
import { localRunAdmissionDraft, localRunAdmissionRefusal } from '@/lib/local-run-admission'
import type { LocalRunCanvasDraft } from '@/lib/local-run-draft'
import { useConsoleWorkflowTemplates } from './use-console-workflow-templates'

/**
 * Admitting this graph through the console. Git workspaces only, sequential stages
 * only, and templates for admitted work come from the server — a folder workspace is
 * told plainly to run locally instead, which is not a lesser outcome.
 */
export function LocalRunDraftAdmission({
  draft,
  onAdmit
}: {
  draft: LocalRunCanvasDraft
  onAdmit: (composer: WorkflowDraft) => void
}) {
  const refusal = localRunAdmissionRefusal(draft)
  const templates = useConsoleWorkflowTemplates(!refusal)
  return (
    <section className="space-y-3 rounded-md border border-border p-3">
      <h3 className="text-sm font-medium">
        {translate('auto.components.local-run.Admission.title', 'Admit through the console')}
      </h3>
      {refusal ? (
        <p role="alert" className="whitespace-pre-wrap break-words text-sm text-destructive">
          {refusal.message}
        </p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.local-run.Admission.help',
              'The console owns admitted work: this hands the stages to the workflow composer, where the card, organization, policies and the exact graph are reviewed and approved.'
            )}
          </p>
          <div className="space-y-1">
            <h4 className="text-xs font-medium text-muted-foreground">
              {translate(
                'auto.components.local-run.Admission.templates',
                'Server templates for admitted work'
              )}
            </h4>
            {templates.state === 'loading' && (
              <p className="text-xs text-muted-foreground">
                {translate('auto.components.local-run.Admission.loading', 'Asking the server…')}
              </p>
            )}
            {templates.state === 'unavailable' && (
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.local-run.Admission.unavailable',
                  'The server did not provide templates for admitted work. Local seed templates are never substituted here.'
                )}{' '}
                {templates.reason}
              </p>
            )}
            {templates.state === 'ready' &&
              (templates.templates.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {translate(
                    'auto.components.local-run.Admission.none',
                    'The server offers no templates for this work.'
                  )}
                </p>
              ) : (
                <ul className="space-y-1 text-xs">
                  {templates.templates.map((template) => (
                    <li key={template.id}>
                      {template.name}
                      {template.status ? ` · ${template.status}` : ''}
                    </li>
                  ))}
                </ul>
              ))}
          </div>
          <Button size="sm" onClick={() => onAdmit(localRunAdmissionDraft(draft))}>
            {translate('auto.components.local-run.Admission.admit', 'Admit…')}
          </Button>
        </>
      )}
    </section>
  )
}
