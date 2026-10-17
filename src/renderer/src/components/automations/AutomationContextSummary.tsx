import {
  DEFAULT_AUTOMATION_NOTIFY,
  type AutomationDefinitionContext
} from '../../../../shared/automation-definition-context'
import { translate } from '@/i18n/i18n'
import { automationDeliveryLabel } from './automation-delivery-label'

export function AutomationContextSummary({
  definition
}: {
  definition: AutomationDefinitionContext
}) {
  const notify = definition.notify ?? DEFAULT_AUTOMATION_NOTIFY
  const yes = translate('routines.definition.enabled', 'Enabled')
  const no = translate('routines.definition.disabled', 'Disabled')
  const fields = [
    [
      translate('routines.definition.trigger', 'Trigger'),
      definition.trigger?.kind === 'pull-request'
        ? translate(
            'routines.definition.prFallback',
            'Pull request: {{event}} (using schedule fallback)',
            { event: definition.trigger.event }
          )
        : translate('routines.definition.scheduleTrigger', 'Schedule')
    ],
    [
      translate('routines.definition.repositories', 'Repositories'),
      definition.repos?.map((repo) => repo.path).join(', ')
    ],
    [
      translate('routines.definition.paths', 'Files and context paths'),
      definition.contextPaths?.join(', ')
    ],
    [translate('routines.definition.notes', 'Context notes'), definition.contextNotes],
    [translate('routines.definition.skills', 'Skills'), definition.tools?.skills.join(', ')],
    [
      translate('routines.definition.connectors', 'Connectors'),
      definition.tools?.mcpServers.join(', ')
    ],
    [
      translate('routines.definition.writes', 'Allow write actions'),
      definition.tools ? (definition.tools.allowWrite ? yes : no) : null
    ],
    [translate('routines.definition.scope', 'Company / domain'), definition.scope],
    [
      translate('routines.definition.delivery', 'Delivery'),
      (definition.delivery ?? [{ kind: 'chat' as const }])
        .map((item) =>
          [automationDeliveryLabel(item.kind), ...Object.values(item).slice(1)].join(': ')
        )
        .join(', ')
    ],
    [
      translate('routines.definition.format', 'Output format'),
      definition.outputFormat ?? 'markdown'
    ],
    [
      translate('routines.definition.notifications', 'Notifications'),
      notify.onFinish
        ? notify.channels
            .map((channel) =>
              channel.kind === 'slack-channel'
                ? `#${channel.channelName}`
                : channel.kind === 'slack-dm'
                  ? `${translate('routines.notify.dm', 'Slack direct message')}${channel.email ? `: ${channel.email}` : ''}`
                  : channel.kind === 'desktop'
                    ? translate('routines.notify.desktop', 'Desktop')
                    : translate('routines.notify.email', 'Email')
            )
            .join(', ')
        : no
    ],
    [
      translate('routines.notify.notable', 'Only when there is something notable'),
      notify.onlyWhenNotable ? yes : no
    ]
  ]
  return (
    <dl className="space-y-1 text-xs" data-routine-definition>
      {fields
        .filter(([, value]) => value)
        .map(([label, value]) => (
          <div key={label} className="break-words">
            <dt className="inline text-muted-foreground">{label}: </dt>
            <dd className="inline">{value}</dd>
          </div>
        ))}
    </dl>
  )
}
