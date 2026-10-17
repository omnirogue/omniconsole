import { translate } from '@/i18n/i18n'
import type { TuiAgent } from '../../../../shared/tui-agent'

export type StepNumber = 1 | 2 | 3 | 4 | 5 | 6

export type StepId =
  | 'account'
  | 'agent'
  | 'theme'
  | 'integrations'
  | 'windows_terminal'
  | 'notifications'

export const STEPS: readonly {
  id: StepId
  stepNumber: StepNumber
  valueKind:
    | 'agent_setup'
    | 'agent'
    | 'theme'
    | 'integrations'
    | 'windows_terminal'
    | 'notifications'
}[] = [
  { id: 'account', stepNumber: 1, valueKind: 'agent_setup' },
  { id: 'agent', stepNumber: 2, valueKind: 'agent' },
  { id: 'theme', stepNumber: 3, valueKind: 'theme' },
  { id: 'integrations', stepNumber: 4, valueKind: 'integrations' },
  { id: 'windows_terminal', stepNumber: 5, valueKind: 'windows_terminal' },
  { id: 'notifications', stepNumber: 6, valueKind: 'notifications' }
]

export type FlagshipPrimaryAiModelOption = {
  id: string
  label: string
  providerLabel: string
  agent: TuiAgent
}

export const FLAGSHIP_PRIMARY_AI_MODELS: readonly FlagshipPrimaryAiModelOption[] = [
  {
    id: 'claude-opus-5-5',
    get label() {
      return translate('primaryAi.models.opus', 'Claude Opus 5.5')
    },
    providerLabel: 'Anthropic',
    agent: 'claude'
  },
  {
    id: 'claude-sonnet-4-6',
    get label() {
      return translate('primaryAi.models.sonnet', 'Claude Sonnet 4.6')
    },
    providerLabel: 'Anthropic',
    agent: 'claude'
  },
  {
    id: 'gpt-6-astra',
    get label() {
      return translate('primaryAi.models.astra', 'GPT-6 Astra')
    },
    providerLabel: 'OpenAI',
    agent: 'codex'
  },
  {
    id: 'gemini-4-argon',
    get label() {
      return translate('primaryAi.models.argon', 'Gemini 4 Argon')
    },
    providerLabel: 'Google',
    agent: 'gemini'
  },
  {
    id: 'moonshot-ai/kimi-k3',
    get label() {
      return translate('primaryAi.models.kimi', 'Kimi K3')
    },
    providerLabel: 'Moonshot',
    agent: 'kimi'
  }
]

export function defaultFlagshipModelForAgent(agent: TuiAgent | null): string | undefined {
  const primaryAgent =
    agent === 'claude-agent-teams' || agent === 'openclaude'
      ? 'claude'
      : agent === 'antigravity'
        ? 'gemini'
        : agent
  return FLAGSHIP_PRIMARY_AI_MODELS.find((option) => option.agent === primaryAgent)?.id
}
