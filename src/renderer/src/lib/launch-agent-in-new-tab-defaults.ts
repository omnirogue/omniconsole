import { getAgentSessionOptionCatalog } from '../../../shared/agent-session-option-catalog'
import {
  tokenizeStartupCommand,
  quoteStartupArg,
  type AgentStartupShell
} from '../../../shared/tui-agent-startup-shell'
import type { TuiAgent } from '../../../shared/tui-agent'

/** Why: launcher defaults must replace model/effort flags while preserving permission and other flags. */
export function conversationLauncherArgs(
  agent: TuiAgent,
  args: string | null,
  shell: AgentStartupShell
): string | null {
  if (!args?.trim()) {
    return args
  }
  const parsed = tokenizeStartupCommand(args, shell)
  const catalog = getAgentSessionOptionCatalog(agent)
  if (!parsed.ok || !catalog) {
    return args
  }
  let tokens = catalog.modelApply.removeAgentArgs?.(parsed.tokens) ?? parsed.tokens
  for (const option of [
    ...catalog.models.flatMap((model) => model.options),
    ...(catalog.unknownModelOptions ?? [])
  ]) {
    if (option.id === 'effort' && option.apply.removeAgentArgs) {
      tokens = option.apply.removeAgentArgs(tokens)
    }
  }
  return tokens.map((token) => quoteStartupArg(token, shell)).join(' ')
}
