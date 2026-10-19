import { CatalogModelEffortFields } from '@/components/build-review/BuildReviewAgentFields'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import { ProjectSettingsCoordinatorOllama } from './ProjectSettingsCoordinatorOllama'
import { getAgentLabel } from '@/lib/agent-catalog'
import { resolveBuildReviewModels } from '../../../../shared/build-review-model-options'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  COORDINATOR_AGENTS,
  LOCAL_OLLAMA_AGENT,
  coordinatorAgentOffersTeam,
  type ProjectCoordinatorDraft
} from './project-settings-draft'

/** The project's chat: which agent runs it, on which model and effort, and as a team where offered. */
export function ProjectSettingsCoordinator({
  id,
  value,
  running,
  title,
  help,
  onChange
}: {
  id: string
  value: ProjectCoordinatorDraft
  /** A chat is running under the saved pick; a new pick applies when it is started again. */
  running: boolean
  title?: string
  help?: string
  onChange: (next: ProjectCoordinatorDraft) => void
}): React.JSX.Element {
  // Why: Local Ollama runs through OpenCode, and only where this app can reach Ollama.
  const offered: readonly TuiAgent[] = window.api?.localOllama
    ? [...COORDINATOR_AGENTS, LOCAL_OLLAMA_AGENT]
    : COORDINATOR_AGENTS
  // Why: a recorded agent this dialog does not offer stays pickable, named by its label.
  const agents: readonly TuiAgent[] = offered.includes(value.agent)
    ? offered
    : [value.agent, ...offered]
  const ollama = value.agent === LOCAL_OLLAMA_AGENT
  const offersTeam = coordinatorAgentOffersTeam(value.agent)
  // Why the seeded catalog: the dialog has no workspace to probe; the launch review panel checks the pick.
  const models = resolveBuildReviewModels(value.agent, null)
  return (
    <section className="space-y-2" data-project-settings-coordinator="">
      <h4 className="text-xs font-medium">
        {title ?? translate('projects.settings.coordinator', 'Coordinator model & effort')}
      </h4>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor={id} className="text-xs">
            {translate('projects.settings.coordinatorAgent', 'Run by')}
          </Label>
          <Select
            value={value.agent}
            onValueChange={(agent) =>
              onChange({
                agent: agent as TuiAgent,
                team: coordinatorAgentOffersTeam(agent as TuiAgent) && value.team
              })
            }
          >
            <SelectTrigger id={id} className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {agents.map((agent) => (
                <SelectItem key={agent} value={agent}>
                  {agent === LOCAL_OLLAMA_AGENT
                    ? translate('projects.settings.coordinatorLocalOllama', 'Local Ollama')
                    : getAgentLabel(agent)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <label className="flex items-center gap-2 pb-2 text-xs">
          <Checkbox
            checked={offersTeam && value.team}
            disabled={!offersTeam}
            onCheckedChange={(checked) => onChange({ ...value, team: checked === true })}
          />
          {translate('projects.settings.coordinatorTeam', 'As a team')}
        </label>
      </div>
      {ollama ? (
        <ProjectSettingsCoordinatorOllama
          id={`${id}-ollama`}
          model={value.model}
          onChange={(model) => onChange({ agent: value.agent, team: false, model })}
        />
      ) : (
        <CatalogModelEffortFields
          role={`${id}-chat`}
          agent={value.agent}
          models={models}
          model={value.model}
          effort={value.effort}
          usableOnly={false}
          onChange={(choice) =>
            onChange({
              agent: value.agent,
              team: value.team,
              ...(choice.model ? { model: choice.model } : {}),
              ...(choice.effort ? { effort: choice.effort } : {})
            })
          }
        />
      )}
      <p className="text-xs text-muted-foreground">
        {help ??
          (running
            ? translate(
                'projects.settings.coordinatorRunning',
                'Starts and follows the project’s threads from its chat. The running chat keeps its agent; this pick applies when it is started again.'
              )
            : translate(
                'projects.settings.coordinatorHelp',
                'Starts and follows the project’s threads from its chat, with the Coordinator instructions. Start it from the project page.'
              ))}
      </p>
    </section>
  )
}
