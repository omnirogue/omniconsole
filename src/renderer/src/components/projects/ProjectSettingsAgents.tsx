import { Plus, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { resolveAgentTemplates } from '../../../../shared/agent-templates'
import { projectAgentFor, type ProjectAgent } from '../../../../shared/project-settings'
import {
  changedProjectAgentTemplate,
  projectAgentTemplates,
  withDefaultProjectAgent,
  withProjectAgent
} from './project-settings-draft'

/** The project's agents, carried with their text; the first is the default for a launch. */
export function ProjectSettingsAgents({
  agents,
  onChange
}: {
  agents: readonly ProjectAgent[]
  onChange: (next: ProjectAgent[]) => void
}): React.JSX.Element {
  const agentTemplates = useAppStore((state) => state.settings?.agentTemplates)
  const templates = resolveAgentTemplates(agentTemplates)
  const addable = projectAgentTemplates(templates).filter(
    (template) => !agents.some((agent) => agent.templateId === template.id)
  )
  return (
    <section className="space-y-2" data-project-settings-agents="">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-medium">{translate('projects.settings.agents', 'Agents')}</h4>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="xs" disabled={addable.length === 0}>
              <Plus className="size-3" />
              {translate('projects.settings.addAgent', 'Add agent')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {addable.map((template) => (
              <DropdownMenuItem
                key={template.id}
                onSelect={() => onChange(withProjectAgent(agents, template))}
              >
                {template.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {agents.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {translate('projects.settings.noAgents', 'No agents yet.')}
        </p>
      ) : (
        <ul className="space-y-1">
          {agents.map((agent, index) => {
            const changed = changedProjectAgentTemplate(agent, templates)
            const current = changed ? projectAgentFor(changed) : null
            return (
              <li
                key={agent.templateId}
                className="space-y-1 rounded border px-2 py-1 text-xs"
                data-project-agent={agent.templateId}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium">{agent.name}</span>
                  {index === 0 ? (
                    <Badge variant="secondary">
                      {translate('projects.settings.defaultAgent', 'Default')}
                    </Badge>
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => onChange(withDefaultProjectAgent(agents, agent.templateId))}
                    >
                      {translate('projects.settings.makeDefault', 'Make default')}
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={translate('projects.settings.removeAgent', 'Remove {{name}}', {
                      name: agent.name
                    })}
                    onClick={() =>
                      onChange(agents.filter((entry) => entry.templateId !== agent.templateId))
                    }
                  >
                    <X className="size-3" />
                  </Button>
                </div>
                {current ? (
                  <div
                    className="flex items-center gap-2 text-muted-foreground"
                    data-project-agent-changed=""
                  >
                    <span className="min-w-0 flex-1">
                      {translate(
                        'projects.settings.templateChanged',
                        'Template changed since it was added.'
                      )}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() =>
                        onChange(agents.map((entry) => (entry === agent ? current : entry)))
                      }
                    >
                      {translate('projects.settings.useCurrentText', 'Use current text')}
                    </Button>
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
