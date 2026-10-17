import { useMemo } from 'react'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  AGENT_TEMPLATE_DEFAULT_ID,
  resolveAgentTemplates,
  type AgentTemplate
} from '../../../../shared/agent-templates'
import type { ProjectAgent } from '../../../../shared/project-settings'

const NO_PROJECT_AGENTS: readonly ProjectAgent[] = []

type AgentTemplateSelectProps = {
  id: string
  /** A template id, or null for Default (no added instructions). */
  value: string | null
  onChange: (templateId: string | null) => void
  disabled?: boolean
  /** Shown under the select when this path cannot deliver the instructions. */
  unavailableReason?: string | null
  /** A project's agents, listed first; the project carries their text to every computer. */
  projectAgents?: readonly ProjectAgent[]
}

/**
 * Which agent template's instructions a dispatched prompt carries. The same list the launcher's
 * "Customize workspace…" menu offers; templates are edited in Settings › Agents.
 */
export function AgentTemplateSelect({
  id,
  value,
  onChange,
  disabled,
  unavailableReason,
  projectAgents = NO_PROJECT_AGENTS
}: AgentTemplateSelectProps): React.JSX.Element {
  const stored = useAppStore((state) => state.settings?.agentTemplates)
  const templates = useMemo(() => resolveAgentTemplates(stored), [stored])
  const selected = value ?? AGENT_TEMPLATE_DEFAULT_ID
  const projectAgent = projectAgents.find((agent) => agent.templateId === selected)
  // Why: the project's copy stands for the template it was made from, so that one is not listed twice.
  const others = templates.filter(
    (template) => !projectAgents.some((agent) => agent.templateId === template.id)
  )
  // Why: a template deleted after it was chosen stays visible, so the person sees it will not apply.
  const missing = !projectAgent && !templates.some((template) => template.id === selected)
  const current = templates.find((template) => template.id === selected)
  const item = (template: AgentTemplate): React.JSX.Element => (
    <SelectItem key={template.id} value={template.id}>
      {template.name}
    </SelectItem>
  )
  return (
    <div className="min-w-0 space-y-1.5">
      <Label htmlFor={id} className="text-xs font-medium">
        {translate('components.agentTemplateSelect.label', 'Agent instructions')}
      </Label>
      <Select
        value={selected}
        onValueChange={(next) => onChange(next === AGENT_TEMPLATE_DEFAULT_ID ? null : next)}
        disabled={disabled || Boolean(unavailableReason)}
      >
        <SelectTrigger id={id} className="min-w-0 w-full" size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {missing ? (
            <SelectItem value={selected}>
              {translate('components.agentTemplateSelect.removed', 'Removed template')}
            </SelectItem>
          ) : null}
          {projectAgents.length ? (
            <SelectGroup>
              <SelectLabel>
                {translate('projects.launcher.agentsGroup', 'From the project')}
              </SelectLabel>
              {projectAgents.map((agent) => (
                <SelectItem key={`project:${agent.templateId}`} value={agent.templateId}>
                  {agent.name}
                </SelectItem>
              ))}
            </SelectGroup>
          ) : null}
          {projectAgents.length ? (
            <SelectGroup>
              <SelectLabel>{translate('projects.launcher.allAgents', 'All agents')}</SelectLabel>
              {others.map(item)}
            </SelectGroup>
          ) : (
            others.map(item)
          )}
        </SelectContent>
      </Select>
      <p className="text-[11px] text-muted-foreground">
        {unavailableReason
          ? unavailableReason
          : projectAgent
            ? translate(
                'projects.launcher.agentFromProjectHint',
                'The project’s copy of this agent opens the thread on every computer.'
              )
            : missing
              ? translate(
                  'components.agentTemplateSelect.removedHint',
                  'This template no longer exists, so no instructions are added.'
                )
              : current?.description ||
                translate(
                  'components.agentTemplateSelect.defaultHint',
                  'Adds nothing beyond the workspace’s own instructions.'
                )}
        {unavailableReason || projectAgent
          ? null
          : ` ${translate('components.agentTemplateSelect.whereEdited', 'Edit templates in Settings › Agents.')}`}
      </p>
    </div>
  )
}
