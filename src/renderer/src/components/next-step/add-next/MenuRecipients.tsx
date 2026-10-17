import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { NextStepRecipient } from '../../../../../shared/next-step-draft'
import { rosterPersonDetail } from '../../../../../shared/team-roster-search'
import type { TuiAgent } from '../../../../../shared/tui-agent'
import type { useNextStepRecipients } from '../use-next-step-recipients'
import { MenuItem, MenuItems } from './MenuItems'
import type { MenuLevel } from './menu-levels'

type Recipients = ReturnType<typeof useNextStepRecipients> & {
  agentDetails?: ReadonlyMap<
    TuiAgent,
    { usedPercent: number | null; windowLabel: string | null; resetDescription: string | null }
  >
  hiddenAgents?: readonly { id: TuiAgent; label: string; reason: string }[]
}

export function MenuRecipients({
  kind,
  level,
  data,
  onMode,
  onPreview,
  onPick
}: {
  kind: 'agent' | 'person'
  level: MenuLevel
  data: Recipients
  onMode: (mode: MenuLevel['mode']) => void
  onPreview: (recipient: NextStepRecipient) => void
  onPick: (recipient: NextStepRecipient) => void
}) {
  const load = kind === 'agent' ? data.agents : data.people
  const review = level.mode === 'review'
  const recipients: { recipient: NextStepRecipient; label: string; detail?: string | null }[] =
    kind === 'agent'
      ? data.agents.phase === 'ready'
        ? data.agents.value.map((agent) => ({
            recipient: {
              kind: 'agent',
              agent: agent.id,
              key: agent.id,
              presetId: review ? 'review' : 'improve',
              instructions: '',
              rounds: 1
            },
            label: agent.label,
            detail: translate('nextStep.agentDefaults', 'Model and effort: agent defaults')
          }))
        : []
      : data.people.phase === 'ready'
        ? data.people.value.map((person) => ({
            recipient: { kind: 'person', key: person.id, id: person.id, name: person.name },
            label: person.name,
            detail: rosterPersonDetail(person)
          }))
        : []
  return (
    <div className="w-56 shrink-0 space-y-2 p-2">
      <div className="flex gap-1" role="group" aria-label={translate('nextStep.mode', 'Mode')}>
        <Button
          size="xs"
          variant={review ? 'ghost' : 'secondary'}
          aria-pressed={!review}
          onClick={() => onMode('handoff')}
        >
          {translate('nextStep.handoffMode', 'Handoff')}
        </Button>
        <Button
          size="xs"
          variant={review ? 'secondary' : 'ghost'}
          aria-pressed={review}
          onClick={() => onMode('review')}
        >
          {translate('nextStep.reviewMode', 'Ask for review')}
        </Button>
      </div>
      <MenuItems label={translate('nextStep.recipients', 'Recipients')}>
        {recipients.map(({ recipient, label, detail }) => {
          const usage = recipient.kind === 'agent' ? data.agentDetails?.get(recipient.agent) : null
          return (
            <MenuItem
              key={recipient.key}
              label={label}
              review={review}
              selected={level.recipients.some((entry) => entry.key === recipient.key)}
              onPreview={review ? undefined : () => onPreview(recipient)}
              onChoose={() => onPick(recipient)}
            >
              <span className="min-w-0 flex-1">
                <span className="block">{label}</span>
                {detail ? <span className="block text-muted-foreground">{detail}</span> : null}
                {usage?.usedPercent != null ? (
                  <span
                    className="block text-muted-foreground"
                    title={usage.resetDescription ?? undefined}
                  >
                    {translate('nextStep.agentUsage', '{{window}} · {{percent}}%', {
                      window: usage.windowLabel ?? '',
                      percent: usage.usedPercent
                    })}
                    <progress
                      className="block h-1 w-full accent-primary"
                      value={usage.usedPercent}
                      max={100}
                    />
                  </span>
                ) : null}
              </span>
            </MenuItem>
          )
        })}
      </MenuItems>
      {load.phase === 'loading' ? (
        <p className="text-xs text-muted-foreground">
          {translate('nextStep.loadingRecipients', 'Loading…')}
        </p>
      ) : null}
      {load.phase === 'error' ? (
        <Button size="xs" variant="ghost" onClick={data.reload}>
          {load.message}
        </Button>
      ) : null}
      {kind === 'person' && data.peopleIncomplete && load.phase === 'ready' ? (
        <p className="border-t pt-2 text-xs text-muted-foreground">
          {translate(
            'nextStep.peopleMayBeIncomplete',
            'The company list could not be read, so this list may be incomplete.'
          )}
        </p>
      ) : null}
      {kind === 'person' && data.peopleSource === 'employees' && load.phase === 'ready' ? (
        <p className="border-t pt-2 text-xs text-muted-foreground">
          {translate(
            'nextStep.peopleFromEmployees',
            'From the employees list; the people directory is not served yet.'
          )}
        </p>
      ) : null}
      {data.hiddenAgents?.length && kind === 'agent' ? (
        <details className="border-t pt-2 text-xs text-muted-foreground">
          <summary>
            {translate('nextStep.hiddenAgents', '{{count}} not shown · why?', {
              count: data.hiddenAgents.length
            })}
          </summary>
          {data.hiddenAgents.map((agent) => (
            <p key={agent.id}>
              {agent.label} · {agent.reason}
            </p>
          ))}
        </details>
      ) : null}
    </div>
  )
}
