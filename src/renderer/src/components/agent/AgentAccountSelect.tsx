import { useMemo } from 'react'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  agentSupportsAccountProfiles,
  listAgentAccountChoices
} from '../../../../shared/agent-account-profiles'
import type { TuiAgent } from '../../../../shared/tui-agent'

/** Sentinel select value meaning "the account the CLI is signed into right now". */
const DEFAULT_ACCOUNT = '__default-account__'

type AgentAccountSelectProps = {
  verifiedChoiceIds?: readonly string[]
  id: string
  agent: TuiAgent | null
  /** `managed:<id>` / `profile:<id>` from listAgentAccountChoices, or null for the default. */
  value: string | null
  onChange: (choiceId: string | null) => void
}

/**
 * The account half of an actor: which sign-in directory the launched CLI starts under.
 * Managed accounts and named profiles are listed from settings; the IDE never stores or
 * rotates credentials — it only picks a directory for this one launch.
 */
export function AgentAccountSelect({
  id,
  agent,
  value,
  onChange,
  verifiedChoiceIds
}: AgentAccountSelectProps): React.JSX.Element {
  const settings = useAppStore((state) => state.settings)
  const choices = useMemo(
    () => (agent ? listAgentAccountChoices(settings, agent) : []),
    [agent, settings]
  )
  const supported = agent ? agentSupportsAccountProfiles(agent) : false
  // Why: a remembered choice whose profile was deleted must stay visible so the person
  // sees what the launch will not do, instead of silently falling back to the default.
  const missingChoice = value && !choices.some((choice) => choice.id === value) ? value : null
  return (
    <div className="min-w-0 space-y-1.5">
      <Label htmlFor={id} className="text-xs font-medium">
        {translate('components.agentAccountSelect.label', 'Account')}
      </Label>
      <Select
        value={value ?? DEFAULT_ACCOUNT}
        onValueChange={(next) => onChange(next === DEFAULT_ACCOUNT ? null : next)}
        disabled={!supported || (choices.length === 0 && !missingChoice)}
      >
        <SelectTrigger id={id} className="min-w-0 w-full" size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={DEFAULT_ACCOUNT}>
            {translate('components.agentAccountSelect.defaultAccount', 'Current sign-in')}
          </SelectItem>
          {missingChoice ? (
            <SelectItem value={missingChoice}>
              {translate('components.agentAccountSelect.missingProfile', 'Removed profile')}
            </SelectItem>
          ) : null}
          {choices.map((choice) => (
            <SelectItem
              key={choice.id}
              value={choice.id}
              disabled={verifiedChoiceIds !== undefined && !verifiedChoiceIds.includes(choice.id)}
            >
              {choice.kind === 'managed'
                ? translate('components.agentAccountSelect.managedAccount', '{{email}} (managed)', {
                    email: choice.label
                  })
                : choice.label}
              {verifiedChoiceIds !== undefined && !verifiedChoiceIds.includes(choice.id)
                ? translate('conversations.accountUnverified', ' — Check sign-in in Settings')
                : null}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-[11px] text-muted-foreground">
        {!supported
          ? translate(
              'components.agentAccountSelect.unsupported',
              'This agent starts under its own current sign-in.'
            )
          : choices.length === 0
            ? translate(
                'components.agentAccountSelect.noChoices',
                'Add a managed account or an account profile in Settings › Agents to pick one here.'
              )
            : translate(
                'components.agentAccountSelect.help',
                'Sets the config directory for this session only. No credentials are stored by OmniConsole.'
              )}
      </p>
    </div>
  )
}
