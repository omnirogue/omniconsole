import { Button } from '@/components/ui/button'
import { useLaunchContext } from '@/components/sidebar/session-folders/new-conversation/launch-context'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import type { SessionAgentTemplateView } from '../../../../shared/session-agent-template'

export function sessionAgentTemplateLabel(view: SessionAgentTemplateView): string {
  switch (view.state) {
    case 'unrecorded':
      return translate('nextAction.agentTemplateUnrecorded', 'Not recorded')
    case 'default':
      return translate('nextAction.agentTemplateDefault', 'Default')
    case 'removed':
    case 'current':
    case 'changed':
      return view.name
  }
}

/** Session details' Agent row: the template this session launched with, and where to edit it. */
export function SessionAgentTemplateFact({
  template
}: {
  template: SessionAgentTemplateView
}): React.JSX.Element {
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)
  const openSettingsPage = useAppStore((state) => state.openSettingsPage)
  const requestEditTemplate = useLaunchContext((state) => state.requestEditTemplate)
  const editableId = 'id' in template && template.state !== 'removed' ? template.id : null
  const edit = (): void => {
    requestEditTemplate(editableId ?? undefined)
    openSettingsTarget({ pane: 'agents', repoId: null, sectionId: 'agent-templates' })
    openSettingsPage()
  }
  return (
    <div
      className="flex min-w-0 items-baseline gap-2 text-xs"
      data-next-action-fact="agent-template"
      data-agent-template-state={template.state}
    >
      <span className="min-w-[78px] shrink-0 text-muted-foreground">
        {translate('nextAction.agentTemplate', 'Agent')}
      </span>
      <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1">
        <span
          className={cn(
            'min-w-0 truncate',
            template.state === 'unrecorded' && 'text-muted-foreground'
          )}
          data-agent-template-name=""
          title={sessionAgentTemplateLabel(template)}
        >
          {sessionAgentTemplateLabel(template)}
        </span>
        {/* Why its own span: a long truncated name must not hide that the template is gone. */}
        {template.state === 'removed' ? (
          <span className="shrink-0 text-muted-foreground" data-agent-template-removed="">
            {translate('nextAction.agentTemplateRemoved', '(removed)')}
          </span>
        ) : null}
        {template.state === 'changed' ? (
          <span className="text-muted-foreground" data-agent-template-changed="">
            {translate(
              'nextAction.agentTemplateChanged',
              'Instructions changed since this session started'
            )}
          </span>
        ) : null}
        {/* Why only a live template: Default adds nothing, and a removed or unrecorded one has no text. */}
        {editableId === null ? null : (
          <Button
            type="button"
            variant="link"
            size="xs"
            className="h-auto px-1 text-xs text-muted-foreground"
            onClick={edit}
          >
            {translate('nextAction.editInstructions', 'Edit instructions…')}
          </Button>
        )}
      </span>
    </div>
  )
}
