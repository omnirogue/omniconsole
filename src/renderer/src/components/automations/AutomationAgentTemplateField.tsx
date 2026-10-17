import { AgentTemplateSelect } from '@/components/agent/AgentTemplateSelect'
import { translate } from '@/i18n/i18n'
import { AGENT_TEMPLATE_DEFAULT_ID } from '../../../../shared/agent-templates'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import type { AutomationDraft } from './AutomationEditorDialog'
import type { AutomationCreateDestinationControl } from './use-automation-create-destination'

/** True when another computer runs the routine and so resolves its template id there. */
export function routineRunsElsewhere(
  repo: Pick<Repo, 'connectionId' | 'executionHostId'> | undefined,
  destination: AutomationCreateDestinationControl | undefined
): boolean {
  const resolution = destination?.resolution
  if (resolution?.status === 'ready' && resolution.authority.kind !== 'desktop') {
    return true
  }
  const host = repo ? parseExecutionHostId(getRepoExecutionHostId(repo)) : null
  return host?.kind === 'ssh' || host?.kind === 'runtime'
}

export function AutomationAgentTemplateField({
  draft,
  onDraftChange,
  runsElsewhere
}: {
  draft: AutomationDraft
  onDraftChange: (updater: (current: AutomationDraft) => AutomationDraft) => void
  runsElsewhere: boolean
}): React.JSX.Element {
  const value =
    draft.agentTemplateId && draft.agentTemplateId !== AGENT_TEMPLATE_DEFAULT_ID
      ? draft.agentTemplateId
      : null
  return (
    <div className="space-y-1">
      <AgentTemplateSelect
        id="automation-agent-template"
        value={value}
        // Why `default` rather than omitted: an update must be able to clear a saved template.
        onChange={(next) =>
          onDraftChange((current) => ({
            ...current,
            agentTemplateId: next ?? AGENT_TEMPLATE_DEFAULT_ID
          }))
        }
      />
      {runsElsewhere ? (
        <p className="text-[11px] text-muted-foreground">
          {translate(
            'automations.agentTemplate.runsElsewhere',
            'Runs on another computer; built-in templates apply there, custom ones only if that computer has them.'
          )}
        </p>
      ) : null}
    </div>
  )
}
