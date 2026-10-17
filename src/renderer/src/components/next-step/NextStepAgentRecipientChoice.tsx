import { useState } from 'react'
import { Bot } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { handoffApi } from '@/components/handoffs/handoff-client'
import { workflowData } from '@/lib/console-workflow-client'
import { translate } from '@/i18n/i18n'
import type { ChatAgentRecipient } from '../../../../shared/console-chat-agent-contract'
import type { ChatRecipient } from '../../../../shared/chat-delivery'
import type { OrgChartPerson } from '../../../../shared/console-companies-contract'
import type { TeamRosterPerson } from '../../../../shared/team-roster-search'
import { RecipientAvatar, recipientPhoto } from './recipient-avatar'

const NO_ORG_PEOPLE: readonly OrgChartPerson[] = []

/** The owning employee's photo when the org chart has one; the robot otherwise. */
function AgentSessionAvatar({
  agent,
  orgPeople
}: {
  agent: ChatAgentRecipient
  orgPeople: readonly OrgChartPerson[]
}): React.JSX.Element {
  const owner: TeamRosterPerson = { id: agent.employeeId, name: agent.name }
  const photo = recipientPhoto(owner, orgPeople)
  return photo ? <RecipientAvatar name={agent.name} photoUrl={photo} /> : <RecipientAvatar agent />
}

/** Existing employee sessions from the same authoritative directory used by chat tags. */
export function NextStepAgentRecipientChoice({
  value,
  onChange,
  orgPeople = NO_ORG_PEOPLE
}: {
  value?: Extract<ChatRecipient, { kind: 'agent' }>
  onChange: (recipient: Extract<ChatRecipient, { kind: 'agent' }>) => void
  orgPeople?: readonly OrgChartPerson[]
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [agents, setAgents] = useState<ChatAgentRecipient[]>([])
  const [query, setQuery] = useState('')
  const load = async (): Promise<void> => {
    setOpen(true)
    setPending(true)
    setError(null)
    try {
      setAgents(workflowData(await handoffApi().agentRecipients()).agents)
    } catch (cause) {
      setAgents([])
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }
  const matches = agents.filter((agent) =>
    `${agent.name} ${agent.projectName ?? ''}`.toLowerCase().includes(query.toLowerCase())
  )
  return (
    <div className="space-y-2">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={pending}
        aria-expanded={open}
        onClick={() => void load()}
      >
        <Bot className="size-3.5" />
        {value?.name ??
          translate('nextStep.existingAgentRecipient', 'Choose an existing employee agent')}
      </Button>
      {pending ? (
        <p role="status" className="text-xs text-muted-foreground">
          {translate('chatDelivery.loadingPeople', 'Loading recipients…')}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {open && !pending && !error ? (
        <div className="space-y-2 rounded-md border border-border p-2">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label={translate('nextStep.findExistingAgent', 'Find an existing agent')}
          />
          <div className="max-h-40 overflow-y-auto scrollbar-sleek">
            {matches.map((agent) => (
              <Button
                type="button"
                key={agent.id}
                size="sm"
                variant={value?.id === agent.id ? 'secondary' : 'ghost'}
                className="w-full justify-start gap-2 truncate"
                onClick={() => {
                  onChange({
                    kind: 'agent',
                    id: agent.id,
                    name: agent.name,
                    employeeId: agent.employeeId,
                    projectId: agent.projectId
                  })
                  setOpen(false)
                }}
              >
                <AgentSessionAvatar agent={agent} orgPeople={orgPeople} />
                <span className="min-w-0 truncate">
                  {agent.name}
                  {agent.projectName ? (
                    <span className="text-muted-foreground">{` · ${agent.projectName}`}</span>
                  ) : null}
                </span>
              </Button>
            ))}
            {!matches.length ? (
              <p className="text-xs text-muted-foreground">
                {translate(
                  'nextStep.noExistingAgents',
                  'No available employee agent sessions. Start the intended session, then refresh.'
                )}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
