import { useEffect, useState } from 'react'
import {
  Bot,
  Folder,
  FolderGit2,
  FolderPlus,
  Home,
  Pencil,
  Settings2,
  SlidersHorizontal
} from 'lucide-react'
import { openProjectCreate } from '@/components/projects/project-settings-dialog-store'
import { SessionContextLauncherRow } from './SessionContextLauncherRow'
import { translate } from '@/i18n/i18n'
import { Badge } from '@/components/ui/badge'
import { useAppStore } from '@/store'
import { Input } from '@/components/ui/input'
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import type { HoverOpenContentProps } from '@/components/next-step/use-hover-open-popover'
import {
  agentTemplateMatches,
  resolveAgentTemplates,
  type AgentTemplate
} from '../../../../../../shared/agent-templates'
import { projectAgentForLaunch } from '../../../../../../shared/project-launch-inheritance'
import { projectAgentTemplateId } from '../../../../../../shared/project-agent-selection'
import type { ProjectAgent } from '../../../../../../shared/project-settings'
import { useActiveLaunchProject } from '@/lib/project-launch'
import { LaunchTargetColumn, useLaunchTargetOptions } from './LaunchTargetColumn'
import {
  launchContextKey,
  rememberTemplate,
  rememberedTemplate,
  rememberedTemplateId,
  useLaunchContext
} from './launch-context'

function subContentProps(hover: HoverOpenContentProps) {
  return {
    onPointerMove: hover.onPointerMove,
    onPointerEnter: hover.onPointerEnter,
    onPointerLeave: hover.onPointerLeave,
    onPointerDownCapture: hover.onPointerDownCapture
  }
}

/** One row of the agent list: a template on this computer, or the project's copy of one. */
type AgentRow = {
  id: string
  name: string
  description: string
  instructions: string | null
  badge: string | null
  /** Only a template on this computer opens in Settings › Agents. */
  editable: boolean
}

function projectAgentRow(agent: ProjectAgent): AgentRow {
  return {
    id: agent.templateId,
    name: agent.name,
    description: agent.instructions.split('\n')[0] ?? '',
    instructions: agent.instructions,
    badge: translate('projects.launcher.agentBadge', 'project'),
    editable: false
  }
}

function templateAgentRow(template: AgentTemplate): AgentRow {
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    instructions: template.instructions,
    badge: template.builtin ? null : translate('localOllama.custom', 'custom'),
    editable: true
  }
}

/**
 * One row of the Model menu, "Customize workspace…", whose submenu holds where the
 * conversation starts and which agent template opens it. Both default to what the app
 * already shows (the selected workspace, the Default template) and apply to every provider.
 */
export function CustomizeWorkspaceRow({
  hover,
  launchWorktreeId,
  onClose,
  contextRow = true
}: {
  hover: HoverOpenContentProps
  launchWorktreeId: string | null
  onClose: () => void
  /** False when the launcher already shows the context row at its top (a project launch). */
  contextRow?: boolean
}): React.JSX.Element {
  const settings = useAppStore((state) => state.settings)
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)
  const openSettingsPage = useAppStore((state) => state.openSettingsPage)
  const setTarget = useLaunchContext((state) => state.setTarget)
  const requestEditTemplate = useLaunchContext((state) => state.requestEditTemplate)
  const options = useLaunchTargetOptions()
  const key = launchContextKey(launchWorktreeId)
  const option = options.find((entry) => entry.key === key)
  const override = useLaunchContext((state) => state.target)
  // Why: a chosen target that dropped out of the list must not keep steering launches.
  useEffect(() => {
    if (override && !option) {
      setTarget(undefined)
    }
  }, [override, option, setTarget])
  const selected = rememberedTemplate(settings, launchWorktreeId)
  const project = useActiveLaunchProject()
  const projectAgents = project?.settings.agents ?? []
  // Why: inside a project its agent opens the thread (project-launch-inheritance.ts), so the
  // project's copies come first and the template they copy is not listed twice.
  const projectAgent = project
    ? projectAgentForLaunch(
        projectAgents,
        projectAgentTemplateId(
          projectAgents,
          settings?.agentTemplates,
          rememberedTemplateId(settings, launchWorktreeId)
        )
      )
    : null
  const selectedId = projectAgent?.templateId ?? selected.id
  const agentName = projectAgent?.name ?? selected.name
  const templates = resolveAgentTemplates(settings?.agentTemplates).filter(
    (template) => !projectAgents.some((agent) => agent.templateId === template.id)
  )
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const projectRows = projectAgents
    .filter((agent) => !needle || agent.name.toLowerCase().includes(needle))
    .map(projectAgentRow)
  const matching = templates
    .filter((template) => agentTemplateMatches(template, query))
    .map(templateAgentRow)
  const rows = [...projectRows, ...matching]
  const TargetIcon = !option
    ? Folder
    : option.kind === 'repo'
      ? FolderGit2
      : option.kind === 'folder'
        ? Folder
        : Home
  const manage = (templateId?: string): void => {
    onClose()
    requestEditTemplate(templateId)
    openSettingsTarget({ pane: 'agents', repoId: null, sectionId: 'agent-templates' })
    openSettingsPage()
  }
  const templateRow = (row: AgentRow): React.JSX.Element => (
    <DropdownMenuSub key={`${row.editable ? 'template' : 'project'}:${row.id}`}>
      <DropdownMenuSubTrigger
        data-launcher-agent-row={row.id}
        data-launcher-agent-source={row.editable ? 'template' : 'project'}
        onClick={(event) => {
          // Why: picking a template refines the launch; the menu stays open for the model.
          event.preventDefault()
          rememberTemplate(launchWorktreeId, row.id)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            rememberTemplate(launchWorktreeId, row.id)
          }
        }}
      >
        <Bot className="size-3.5" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate">{row.name}</span>
            {row.badge ? <Badge variant="secondary">{row.badge}</Badge> : null}
          </div>
          <div className="truncate text-xs text-muted-foreground">{row.description}</div>
        </div>
        {row.id === selectedId ? (
          <span className="text-xs text-muted-foreground">
            {translate('launchContext.selected', 'Selected')}
          </span>
        ) : null}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-72" {...subContentProps(hover)}>
        <DropdownMenuLabel>{row.name}</DropdownMenuLabel>
        <p className="px-2 pb-1 text-[11px] leading-4 whitespace-pre-wrap text-muted-foreground">
          {row.instructions
            ? row.instructions.split('\n').slice(0, 6).join('\n')
            : translate(
                'launchContext.defaultAddsNothing',
                'Adds nothing. The session reads the workspace’s own files as they are.'
              )}
        </p>
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault()
            rememberTemplate(launchWorktreeId, row.id)
          }}
        >
          {translate('launchContext.use', 'Use {{name}}', { name: row.name })}
        </DropdownMenuItem>
        {row.editable ? (
          <DropdownMenuItem onSelect={() => manage(row.id)}>
            <Pencil className="size-3.5" />
            {translate('launchContext.editInstructions', 'Edit instructions…')}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger
        className="items-start gap-2.5 py-2"
        onClick={() => {
          onClose()
          openProjectCreate()
        }}
      >
        <SlidersHorizontal aria-hidden="true" className="mt-0.5 size-3.5" />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span>{translate('launchContext.customize', 'Create Project')}</span>
          <span className="truncate text-xs font-normal text-muted-foreground">
            {translate('launchContext.customizeSummary', 'In {{target}} · {{agent}}', {
              target:
                option?.name ?? translate('launchContext.unknownTarget', 'Selected workspace'),
              agent: agentName
            })}
          </span>
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-72" {...subContentProps(hover)}>
        <DropdownMenuItem
          onSelect={() => {
            onClose()
            openProjectCreate()
          }}
        >
          <FolderPlus className="size-3.5" />
          <div className="min-w-0 flex-1">
            <div>{translate('projects.create.action', 'Create Project')}</div>
            <div className="truncate text-xs text-muted-foreground">
              {translate(
                'projects.create.actionDetail',
                'Create a universal project with coordinator & thread defaults'
              )}
            </div>
          </div>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <TargetIcon className="size-3.5" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate">
                  {translate('localOllama.inTarget', 'In {{name}}', {
                    name:
                      option?.name ?? translate('launchContext.unknownTarget', 'Selected workspace')
                  })}
                </span>
                {option ? (
                  <Badge variant="secondary">
                    {option.kind === 'repo'
                      ? translate('launchContext.repository', 'repository')
                      : option.kind === 'folder'
                        ? translate('launchContext.folder', 'folder')
                        : translate('launchContext.workRoot', 'work root')}
                  </Badge>
                ) : null}
              </div>
              <div className="truncate text-xs text-muted-foreground">{option?.detail}</div>
            </div>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent
            className="w-72 max-h-96 overflow-y-auto scrollbar-sleek"
            {...subContentProps(hover)}
          >
            <LaunchTargetColumn
              options={options}
              selectedKey={key}
              onSelect={setTarget}
              onClose={onClose}
            />
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Bot className="size-3.5" />
            <div className="min-w-0 flex-1">
              <div className="truncate">
                {translate('launchContext.agent', 'Agent: {{name}}', { name: agentName })}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {projectAgent
                  ? translate(
                      'projects.launcher.agentFromProject',
                      'From the project; applies on every computer'
                    )
                  : selected.instructions
                    ? selected.description
                    : translate(
                        'launchContext.defaultDescription',
                        'Project and global instructions only'
                      )}
              </div>
            </div>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent
            className="w-72 max-h-96 overflow-y-auto scrollbar-sleek"
            {...subContentProps(hover)}
          >
            <DropdownMenuLabel>
              {translate('launchContext.agentTitle', 'Agent · applies to every model')}
            </DropdownMenuLabel>
            <div className="px-2 pb-2">
              <Input
                aria-label={translate('localOllama.searchAgents', 'Search agents')}
                placeholder={translate('localOllama.searchPlaceholder', 'Search agents…')}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Escape') {
                    event.stopPropagation()
                  }
                  if (event.key === 'Enter' && rows[0]) {
                    event.preventDefault()
                    rememberTemplate(launchWorktreeId, rows[0].id)
                  }
                }}
              />
            </div>
            {projectRows.length ? (
              <DropdownMenuLabel>
                {translate('projects.launcher.agentsGroup', 'From the project')}
              </DropdownMenuLabel>
            ) : null}
            {projectRows.map(templateRow)}
            {projectRows.length && matching.length ? (
              <DropdownMenuLabel>
                {translate('projects.launcher.allAgents', 'All agents')}
              </DropdownMenuLabel>
            ) : null}
            {matching.map(templateRow)}
            {!rows.length ? (
              <p className="px-2 py-1 text-xs text-muted-foreground">
                {translate(
                  'localOllama.noAgentMatch',
                  'No agent matches. Create one under Manage agents.'
                )}
              </p>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => manage()}>
              <Settings2 className="size-3.5" />
              <div className="min-w-0 flex-1">
                <div>{translate('localOllama.manageAgents', 'Manage agents…')}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {translate(
                    'localOllama.manageAgentsDetail',
                    'Edit instructions, add a template, pull models'
                  )}
                </div>
              </div>
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {contextRow ? (
          <>
            <DropdownMenuSeparator />
            <SessionContextLauncherRow hover={hover} worktreeId={launchWorktreeId} />
          </>
        ) : null}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
