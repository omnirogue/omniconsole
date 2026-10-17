import { useCallback, useEffect } from 'react'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { Repo } from '../../../../shared/repo-types'
import { RoutineTeamScopePicker } from '@/components/sidebar/routines/RoutineTeamScopePicker'
import type { AutomationDraft } from './AutomationEditorDialog'
import { AutomationNotificationFields } from './AutomationNotificationFields'
import { useAutomationToolCatalog } from './use-automation-tool-catalog'

export function AutomationDefinitionTabs({
  draft,
  repos,
  onDraftChange
}: {
  draft: AutomationDraft
  repos: readonly Repo[]
  onDraftChange: (update: (current: AutomationDraft) => AutomationDraft) => void
}) {
  const catalog = useAutomationToolCatalog(
    repos.find((repo) => repo.id === draft.projectId),
    draft.workspaceId,
    draft.agentId
  )
  useEffect(() => {
    if (!draft.templateConnectorPresets?.length || !catalog.mcpServers.length) {
      return
    }
    onDraftChange((current) => ({
      ...current,
      tools: {
        ...(current.tools ?? { skills: [], mcpServers: [], allowWrite: false }),
        mcpServers: [
          ...new Set(
            (current.tools?.mcpServers ?? []).map(
              (name) =>
                catalog.mcpServers.find((configured) =>
                  configured.toLowerCase().includes(name.toLowerCase())
                ) ?? name
            )
          )
        ]
      }
    }))
  }, [catalog.mcpServers, draft.templateConnectorPresets, onDraftChange])
  const tools = draft.tools ?? { skills: [], mcpServers: [], allowWrite: false }
  const scopeChanged = useCallback(
    (scope: string) => onDraftChange((current) => ({ ...current, scope })),
    [onDraftChange]
  )
  const choose = (field: 'skills' | 'mcpServers', value: string, checked: boolean) =>
    onDraftChange((current) => ({
      ...current,
      tools: {
        ...tools,
        [field]: checked
          ? [...new Set([...tools[field], value])]
          : tools[field].filter((name) => name !== value)
      }
    }))
  return (
    <Tabs defaultValue="connectors" className="mt-5 border-t pt-4">
      <TabsList className="w-full">
        <TabsTrigger value="connectors">
          {translate('routines.definition.connectors', 'Connectors')}
        </TabsTrigger>
        <TabsTrigger value="behavior">
          {translate('routines.definition.behavior', 'Behavior')}
        </TabsTrigger>
        <TabsTrigger value="notifications">
          {translate('routines.definition.notifications', 'Notifications')}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="connectors" className="space-y-3">
        {catalog.error ? (
          <p className="text-xs text-muted-foreground">
            {translate(
              'routines.definition.catalogUnavailable',
              'Some tools could not be loaded: {{reason}}',
              { reason: catalog.error }
            )}
          </p>
        ) : null}
        {(['skills', 'mcpServers'] as const).map((field) => (
          <div key={field} className="space-y-2">
            <Label>
              {field === 'skills'
                ? translate('routines.definition.skills', 'Skills')
                : translate('routines.definition.connectors', 'Connectors')}
            </Label>
            {[...new Set([...catalog[field], ...tools[field]])].map((name) => (
              <Label key={name} className="flex items-center gap-2 text-xs">
                <Checkbox
                  checked={tools[field].includes(name)}
                  disabled={!catalog[field].includes(name)}
                  onCheckedChange={(value) => choose(field, name, value === true)}
                />
                {name}
                {!catalog[field].includes(name) ? (
                  <Badge variant="secondary">
                    {translate('routines.definition.notConnected', 'Not connected')}
                  </Badge>
                ) : null}
              </Label>
            ))}
          </div>
        ))}
        <div className="flex flex-wrap gap-1">
          {draft.templateConnectorPresets?.map((preset) => {
            const connected = catalog.mcpServers.find((name) => name.toLowerCase().includes(preset))
            return (
              <Badge
                key={preset}
                variant="secondary"
                className={connected ? '' : 'text-muted-foreground'}
              >
                {preset}
                {connected
                  ? ''
                  : ` · ${translate('routines.definition.notConnected', 'Not connected')}`}
              </Badge>
            )
          })}
        </div>
        <Label className="flex items-center gap-2">
          <Checkbox
            checked={tools.allowWrite}
            onCheckedChange={(value) =>
              onDraftChange((current) => ({
                ...current,
                tools: { ...tools, allowWrite: value === true }
              }))
            }
          />
          {translate('routines.definition.writes', 'Allow write actions')}
        </Label>
        {tools.allowWrite ? (
          <p className="rounded-md border border-status-warning-border bg-status-warning-background p-2 text-xs text-status-warning">
            {translate(
              'routines.definition.writeWarning',
              'This routine can make changes through its connected tools. Review its instructions and destinations.'
            )}
          </p>
        ) : null}
      </TabsContent>
      <TabsContent value="behavior" className="space-y-3">
        <Label>{translate('routines.definition.paths', 'Files and context paths')}</Label>
        <Textarea
          aria-label={translate('routines.definition.paths', 'Files and context paths')}
          value={draft.contextPaths?.join('\n') ?? ''}
          onChange={(event) =>
            onDraftChange((current) => ({
              ...current,
              contextPaths: event.target.value.split('\n').filter(Boolean)
            }))
          }
        />
        <Label>{translate('routines.definition.notes', 'Context notes')}</Label>
        <Textarea
          aria-label={translate('routines.definition.notes', 'Context notes')}
          value={draft.contextNotes ?? ''}
          onChange={(event) =>
            onDraftChange((current) => ({ ...current, contextNotes: event.target.value }))
          }
        />
        <Label>{translate('routines.definition.scope', 'Company / domain')}</Label>
        {draft.scope ? (
          <div className="flex items-center gap-2 text-xs">
            <span>{draft.scope}</span>
            <Button variant="ghost" size="xs" onClick={() => scopeChanged('')}>
              {translate('routines.definition.changeScope', 'Change scope')}
            </Button>
          </div>
        ) : (
          <RoutineTeamScopePicker onChange={scopeChanged} />
        )}
        <Label>{translate('routines.definition.trigger', 'Trigger')}</Label>
        <p className="text-xs">
          {draft.trigger?.kind === 'pull-request'
            ? translate(
                'routines.definition.prFallback',
                'Pull request: {{event}} (using schedule fallback)',
                { event: draft.trigger.event }
              )
            : translate('routines.definition.scheduleTrigger', 'Schedule')}
        </p>
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} className="text-xs text-muted-foreground" aria-disabled="true">
              {translate('routines.definition.prTrigger', 'Pull request event')}
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {translate(
              'routines.definition.prUnavailable',
              'Pull request triggers are not available. This routine uses its schedule fallback.'
            )}
          </TooltipContent>
        </Tooltip>
      </TabsContent>
      <TabsContent value="notifications">
        <AutomationNotificationFields draft={draft} onDraftChange={onDraftChange} />
      </TabsContent>
    </Tabs>
  )
}
