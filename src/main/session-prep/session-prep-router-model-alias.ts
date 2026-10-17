import type { TuiAgent } from '../../shared/tui-agent'

const CLAUDE_ALIASES: Record<string, string> = {
  'opus 5.5': 'opus',
  'opus-5.5': 'opus',
  'opus-5-5': 'opus',
  'claude-opus-5.5': 'opus',
  'claude-opus-5-5': 'opus',
  'claude opus 5.5': 'opus',
  'claude opus 5 5': 'opus',
  'sonnet 5.5': 'sonnet',
  'sonnet-5.5': 'sonnet',
  'sonnet-5-5': 'sonnet',
  'claude-sonnet-5.5': 'sonnet',
  'claude-sonnet-5-5': 'sonnet',
  'haiku 5.5': 'haiku',
  'haiku-5.5': 'haiku',
  'haiku-5-5': 'haiku',
  'claude-haiku-5.5': 'haiku',
  'claude-haiku-5-5': 'haiku',
  'fable 5.1': 'fable',
  'fable-5.1': 'fable',
  'fable-5-1': 'fable',
  'claude-fable-5.1': 'fable',
  'claude-fable-5-1': 'fable'
}

const CODEX_ALIASES: Record<string, string> = {
  astra: 'gpt-6-astra',
  'astra 6': 'gpt-6-astra',
  'astra-6': 'gpt-6-astra',
  'gpt-6-astra': 'gpt-6-astra',
  'gpt 6 astra': 'gpt-6-astra',
  sol: 'gpt-6.1-sol',
  'sol 6.1': 'gpt-6.1-sol',
  'sol 6 1': 'gpt-6.1-sol',
  'sol-6.1': 'gpt-6.1-sol',
  'sol-6-1': 'gpt-6.1-sol',
  'gpt-6.1-sol': 'gpt-6.1-sol',
  'gpt-6-1-sol': 'gpt-6.1-sol',
  'gpt 6.1 sol': 'gpt-6.1-sol',
  'sol 5.6': 'gpt-5.6-sol',
  'sol-5.6': 'gpt-5.6-sol',
  luna: 'gpt-6-luna',
  'luna 6': 'gpt-6-luna',
  'luna-6': 'gpt-6-luna',
  'gpt-6-luna': 'gpt-6-luna',
  'luna 5.6': 'gpt-5.6-luna',
  'luna-5.6': 'gpt-5.6-luna',
  terra: 'gpt-5.6-terra',
  'terra 5.6': 'gpt-5.6-terra',
  'terra-5.6': 'gpt-5.6-terra'
}

const GEMINI_ALIASES: Record<string, string> = {
  argon: 'gemini-4-argon',
  'argon 4': 'gemini-4-argon',
  'argon-4': 'gemini-4-argon',
  'gemini 4 argon': 'gemini-4-argon',
  'gemini-4-argon': 'gemini-4-argon',
  'gemini 3.8 flash': 'gemini-3.8-flash',
  'gemini 3-8-flash': 'gemini-3.8-flash',
  'gemini 3 8 flash': 'gemini-3.8-flash',
  'gemini-3-8-flash': 'gemini-3.8-flash',
  'gemini-3.8-flash': 'gemini-3.8-flash',
  '3-8-flash': 'gemini-3.8-flash',
  '3.8-flash': 'gemini-3.8-flash',
  'flash 3.8': 'gemini-3.8-flash'
}

/** Existing estate aliases only; provider discovery still verifies the canonical ID. */
export function estateRouterModelAlias(
  model: string | undefined,
  provider?: TuiAgent
): string | undefined {
  if (!model) {
    return model
  }
  const key = model.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!provider || provider === 'codex') {
    const codex = CODEX_ALIASES[key]
    if (codex) {
      return codex
    }
  }
  if (!provider || provider === 'claude') {
    const claude = CLAUDE_ALIASES[key]
    if (claude) {
      return claude
    }
  }
  if (!provider || provider === 'gemini') {
    const gemini = GEMINI_ALIASES[key]
    if (gemini) {
      return gemini
    }
  }
  return model
}
