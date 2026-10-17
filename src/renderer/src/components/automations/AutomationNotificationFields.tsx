import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  DEFAULT_AUTOMATION_NOTIFY,
  type AutomationAlertChannel
} from '../../../../shared/automation-definition-context'
import type { AutomationDraft } from './AutomationEditorDialog'
import { useRoutineSlack } from './use-routine-slack'
import { RoutineSlackChannelPicker } from './RoutineSlackChannelPicker'

export function AutomationNotificationFields({
  draft,
  onDraftChange
}: {
  draft: AutomationDraft
  onDraftChange: (update: (current: AutomationDraft) => AutomationDraft) => void
}) {
  const notify = draft.notify ?? DEFAULT_AUTOMATION_NOTIFY
  const slack = useRoutineSlack()
  const slackReady = Boolean(slack.status?.authenticated && slack.status.connection)
  const setChannels = (channels: AutomationAlertChannel[]) =>
    onDraftChange((current) => ({
      ...current,
      notify: { ...(current.notify ?? DEFAULT_AUTOMATION_NOTIFY), channels }
    }))
  const toggle = (kind: AutomationAlertChannel['kind'], checked: boolean) => {
    const remaining = notify.channels.filter((row) => row.kind !== kind)
    setChannels(
      checked
        ? [
            ...remaining,
            kind === 'slack-channel' ? { kind, channelId: '', channelName: '' } : { kind }
          ]
        : remaining
    )
  }
  const rows = [
    {
      kind: 'desktop' as const,
      title: translate('routines.notify.desktop', 'Desktop'),
      description: translate('routines.notify.desktopHelp', 'Show a notification on this computer.')
    },
    {
      kind: 'slack-dm' as const,
      title: translate('routines.notify.dm', 'Slack direct message'),
      description: translate(
        'routines.notify.dmHelp',
        'Message your Slack account, matched by your account email.'
      )
    },
    {
      kind: 'slack-channel' as const,
      title: translate('routines.notify.channel', 'Slack channels'),
      description: translate(
        'routines.notify.channelHelp',
        'Post a summary and run link to the selected channels.'
      )
    },
    {
      kind: 'email' as const,
      title: translate('routines.notify.email', 'Email'),
      description: translate('routines.notify.emailHelp', 'Send a summary to your account email.')
    }
  ]
  return (
    <div className="space-y-4" data-routine-notifications>
      <Label className="flex items-center gap-2">
        <Checkbox
          checked={notify.onFinish}
          onCheckedChange={(value) =>
            onDraftChange((current) => ({
              ...current,
              notify: { ...notify, onFinish: value === true }
            }))
          }
        />
        {translate('routines.notify.enabled', 'Notify me when this routine finishes')}
      </Label>
      <p className="text-xs text-muted-foreground">
        {translate(
          'routines.notify.help',
          'Alerts include a short summary and a link to the run. Output is delivered separately.'
        )}
      </p>
      <Label className="flex items-center gap-2">
        <Checkbox
          disabled={!notify.onFinish}
          checked={notify.onlyWhenNotable}
          onCheckedChange={(value) =>
            onDraftChange((current) => ({
              ...current,
              notify: { ...notify, onlyWhenNotable: value === true }
            }))
          }
        />
        {translate('routines.notify.notable', 'Only when there is something notable')}
      </Label>
      <div className="space-y-1 text-xs" role="status">
        {!slack.status ? (
          translate('routines.notify.checkingSlack', 'Checking Slack connection…')
        ) : !slack.status.authenticated ? (
          <>
            <p>
              {translate(
                'routines.notify.signInSlack',
                'Sign in to your company account to send Slack alerts.'
              )}
            </p>
            <Button
              variant="outline"
              size="xs"
              onClick={() => useAppStore.getState().openSettingsPage()}
            >
              {translate('routines.notify.accountSettings', 'Account settings')}
            </Button>
          </>
        ) : !slack.status.connection ? (
          <p>
            {translate(
              'routines.notify.slackUnavailable',
              'Slack is not connected on the hub. Ask your company administrator to connect it.'
            )}
          </p>
        ) : (
          <p>
            {translate('routines.notify.slackConnected', 'Slack: {{workspace}}', {
              workspace: slack.status.connection.title
            })}
          </p>
        )}
        {slack.error ? <p className="text-muted-foreground">{slack.error}</p> : null}
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            void slack.refresh()
          }}
        >
          {translate('routines.notify.refreshConnection', 'Refresh connection')}
        </Button>
      </div>
      {rows.map((row) => (
        <div key={row.kind} className="space-y-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <div>
                <Label className="flex items-center gap-2">
                  <Checkbox
                    disabled={
                      !notify.onFinish ||
                      row.kind === 'email' ||
                      (row.kind.startsWith('slack') && !slackReady)
                    }
                    checked={notify.channels.some((channel) => channel.kind === row.kind)}
                    onCheckedChange={(value) => toggle(row.kind, value === true)}
                  />
                  {row.title}
                </Label>
              </div>
            </TooltipTrigger>
            {row.kind === 'email' ? (
              <TooltipContent>
                {translate(
                  'routines.notify.emailUnavailable',
                  'No email sender is configured in this app.'
                )}
              </TooltipContent>
            ) : null}
          </Tooltip>
          <p className="pl-6 text-xs text-muted-foreground">{row.description}</p>
          {row.kind === 'slack-channel' &&
          notify.channels.some((channel) => channel.kind === row.kind) ? (
            <RoutineSlackChannelPicker
              disabled={!notify.onFinish || !slackReady}
              channels={slack.channels}
              refresh={slack.refresh}
              selected={notify.channels.filter(
                (channel): channel is Extract<AutomationAlertChannel, { kind: 'slack-channel' }> =>
                  channel.kind === 'slack-channel' && Boolean(channel.channelName)
              )}
              onChange={(channels) =>
                setChannels([
                  ...notify.channels.filter((channel) => channel.kind !== 'slack-channel'),
                  ...(channels.length
                    ? channels
                    : [{ kind: 'slack-channel', channelId: '', channelName: '' } as const])
                ])
              }
            />
          ) : null}
          {row.kind === 'slack-dm' &&
          notify.channels.some((channel) => channel.kind === row.kind) ? (
            <Input
              type="email"
              disabled={!notify.onFinish || !slackReady}
              aria-label={translate(
                'routines.notify.dmOverride',
                'Slack recipient email (optional)'
              )}
              placeholder={
                slack.status?.ownerEmail ??
                translate('routines.notify.ownerEmail', 'Your company account email')
              }
              value={notify.channels.find((channel) => channel.kind === 'slack-dm')?.email ?? ''}
              onChange={(event) =>
                setChannels([
                  ...notify.channels.filter((channel) => channel.kind !== 'slack-dm'),
                  { kind: 'slack-dm', email: event.target.value || undefined }
                ])
              }
            />
          ) : null}
        </div>
      ))}
    </div>
  )
}
