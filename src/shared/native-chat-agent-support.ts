import { isPiCompatibleAgentType as isPiFamilyTranscriptAgent } from './pi-agent-kind'
import type { TuiAgent } from './tui-agent'

export { isPiFamilyTranscriptAgent }

export type NativeChatTranscriptAgent = 'claude' | 'codex' | 'grok' | 'omp' | 'pi' | 'prime-agent'

/** Agents whose transcripts the native chat view can parse and render, in the
 *  order the settings pane advertises them. */
export const NATIVE_CHAT_SUPPORTED_AGENT_LIST: readonly TuiAgent[] = [
  'claude',
  'openclaude',
  'codex',
  'grok',
  'omp',
  'pi',
  'prime-agent'
]

export const NATIVE_CHAT_SUPPORTED_AGENTS: ReadonlySet<string> = new Set(
  NATIVE_CHAT_SUPPORTED_AGENT_LIST
)

export function isNativeChatSupportedAgent(agent: string | null | undefined): boolean {
  return agent != null && NATIVE_CHAT_SUPPORTED_AGENTS.has(agent)
}

/** Team launch modes whose lead pane is a plain Claude Code process. Chat renders that
 *  lead's transcript only; teammates stay in their own split terminal panes, so this is
 *  deliberately not in the advertised support list. */
export function isNativeChatTeamLeadAgent(agent: string | null | undefined): boolean {
  return agent === 'claude-agent-teams'
}

/** Whether a launched or detected agent may open in the chat view at all. */
export function canRenderNativeChatForAgent(agent: string | null | undefined): boolean {
  return isNativeChatSupportedAgent(agent) || isNativeChatTeamLeadAgent(agent)
}

/** The agent identity chat reads and writes for a pane, or null when chat cannot render it.
 *  A team lead is the Claude Code process `omni claude-teams` execs, so chat speaks to it as
 *  Claude; every other agent keeps its own identity (OpenClaude keeps its launch behaviour). */
export function resolveNativeChatPaneAgent<T extends string>(
  agent: T | null | undefined
): T | NativeChatTranscriptAgent | null {
  if (!agent || !canRenderNativeChatForAgent(agent)) {
    return null
  }
  return isNativeChatTeamLeadAgent(agent) ? resolveNativeChatTranscriptAgent(agent) : agent
}

/** OMP resolves its session on the SSH relay; the other id-only providers remain local. */
export function nativeChatRequiresLocalTranscript(agent: string | null | undefined): boolean {
  const transcriptAgent = resolveNativeChatTranscriptAgent(agent)
  return (
    transcriptAgent === 'grok' ||
    (transcriptAgent !== 'omp' && isPiFamilyTranscriptAgent(transcriptAgent))
  )
}

/** Which question selector's keystrokes answer this agent's card; independent of chat support. */
export type AskAnswerKeyAgent = 'claude' | 'codex' | 'omp' | 'grok' | 'gemini' | 'qwen' | 'hermes'

export function resolveAskAnswerKeyAgent(
  agent: string | null | undefined
): AskAnswerKeyAgent | null {
  const transcriptAgent = resolveNativeChatTranscriptAgent(agent)
  if (
    transcriptAgent === 'claude' ||
    transcriptAgent === 'codex' ||
    transcriptAgent === 'omp' ||
    transcriptAgent === 'grok'
  ) {
    return transcriptAgent
  }
  if (agent === 'gemini' || agent === 'hermes') {
    return agent
  }
  return agent === 'qwen-code' ? 'qwen' : null
}

/** Selectors need agent-specific keystrokes; pasting a label can commit the default. An async
 *  question (Codex `request_user_input_async`) has no selector: it takes a message. */
export function shouldStepNativeChatAskAnswer(
  agent: string | null | undefined,
  prompt?: { delivery?: 'async' }
): boolean {
  const keyAgent = resolveAskAnswerKeyAgent(agent)
  // Why: these selectors never take a message, whatever a stray `delivery` field says.
  if (keyAgent === 'gemini' || keyAgent === 'qwen' || keyAgent === 'hermes') {
    return true
  }
  if (prompt?.delivery === 'async') {
    return false
  }
  return keyAgent !== null
}

export function resolveNativeChatTranscriptAgent(
  agent: string | null | undefined
): NativeChatTranscriptAgent | null {
  // Why: OpenClaude writes the Claude transcript format and layout even though
  // OmniConsole preserves its distinct agent identity for launch and UI behavior.
  // An Agent Teams lead is `omni claude-teams` exec'ing Claude Code, so it writes one too.
  if (agent === 'claude' || agent === 'openclaude' || isNativeChatTeamLeadAgent(agent)) {
    return 'claude'
  }
  if (
    agent === 'codex' ||
    agent === 'grok' ||
    agent === 'omp' ||
    agent === 'pi' ||
    agent === 'prime-agent'
  ) {
    return agent
  }
  return null
}
