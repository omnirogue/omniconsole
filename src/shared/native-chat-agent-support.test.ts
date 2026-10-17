import { describe, expect, it } from 'vitest'
import {
  canRenderNativeChatForAgent,
  isNativeChatSupportedAgent,
  isPiFamilyTranscriptAgent,
  isNativeChatTeamLeadAgent,
  nativeChatRequiresLocalTranscript,
  resolveNativeChatPaneAgent,
  resolveNativeChatTranscriptAgent,
  shouldStepNativeChatAskAnswer
} from './native-chat-agent-support'

describe('resolveNativeChatTranscriptAgent', () => {
  it('maps OpenClaude onto the Claude transcript format', () => {
    expect(resolveNativeChatTranscriptAgent('openclaude')).toBe('claude')
    expect(resolveNativeChatTranscriptAgent('claude')).toBe('claude')
  })

  it('passes codex, grok and omp through and rejects everything else', () => {
    expect(resolveNativeChatTranscriptAgent('codex')).toBe('codex')
    expect(resolveNativeChatTranscriptAgent('grok')).toBe('grok')
    expect(resolveNativeChatTranscriptAgent('omp')).toBe('omp')
    expect(resolveNativeChatTranscriptAgent('cursor')).toBeNull()
    expect(resolveNativeChatTranscriptAgent(null)).toBeNull()
    expect(resolveNativeChatTranscriptAgent(undefined)).toBeNull()
  })
})

describe('isNativeChatSupportedAgent', () => {
  it('recognizes the parseable agents and rejects unknown / nullish input', () => {
    expect(isNativeChatSupportedAgent('claude')).toBe(true)
    expect(isNativeChatSupportedAgent('openclaude')).toBe(true)
    expect(isNativeChatSupportedAgent('omp')).toBe(true)
    expect(isNativeChatSupportedAgent('cursor')).toBe(false)
    expect(isNativeChatSupportedAgent(null)).toBe(false)
    expect(isNativeChatSupportedAgent(undefined)).toBe(false)
  })
})

describe('Claude Agent Teams lead routing', () => {
  it('reads the lead pane as a Claude transcript', () => {
    expect(resolveNativeChatTranscriptAgent('claude-agent-teams')).toBe('claude')
    expect(isNativeChatTeamLeadAgent('claude-agent-teams')).toBe(true)
    expect(canRenderNativeChatForAgent('claude-agent-teams')).toBe(true)
  })

  it('does not advertise teams as generally chat-supported', () => {
    expect(isNativeChatSupportedAgent('claude-agent-teams')).toBe(false)
    expect(isNativeChatTeamLeadAgent('claude')).toBe(false)
    expect(canRenderNativeChatForAgent('gemini')).toBe(false)
  })

  it('lets chat speak to the lead as Claude and keeps every other identity', () => {
    expect(resolveNativeChatPaneAgent('claude-agent-teams')).toBe('claude')
    expect(resolveNativeChatPaneAgent('claude')).toBe('claude')
    expect(resolveNativeChatPaneAgent('openclaude')).toBe('openclaude')
    expect(resolveNativeChatPaneAgent('codex')).toBe('codex')
    expect(resolveNativeChatPaneAgent('gemini')).toBeNull()
    expect(resolveNativeChatPaneAgent(null)).toBeNull()
  })
})

describe('nativeChatRequiresLocalTranscript', () => {
  it('keeps providers without a host resolver local', () => {
    expect(nativeChatRequiresLocalTranscript('grok')).toBe(true)
    expect(nativeChatRequiresLocalTranscript('omp')).toBe(false)
    expect(nativeChatRequiresLocalTranscript('claude')).toBe(false)
    expect(nativeChatRequiresLocalTranscript('openclaude')).toBe(false)
    expect(nativeChatRequiresLocalTranscript('codex')).toBe(false)
    expect(nativeChatRequiresLocalTranscript('cursor')).toBe(false)
    expect(nativeChatRequiresLocalTranscript(null)).toBe(false)
    expect(nativeChatRequiresLocalTranscript(undefined)).toBe(false)
  })
})

describe('shouldStepNativeChatAskAnswer', () => {
  it('steps the digit-commit selector agents (Claude, OpenClaude, Codex)', () => {
    expect(shouldStepNativeChatAskAnswer('claude')).toBe(true)
    expect(shouldStepNativeChatAskAnswer('openclaude')).toBe(true)
    // Codex 0.145's request_user_input card ignores typed labels and commits on
    // the highlighted row, so pasted answers misdeliver like STA-1860.
    expect(shouldStepNativeChatAskAnswer('codex')).toBe(true)
  })

  it('does not step other or unknown agents', () => {
    expect(shouldStepNativeChatAskAnswer('pi')).toBe(false)
    expect(shouldStepNativeChatAskAnswer('cursor')).toBe(false)
    expect(shouldStepNativeChatAskAnswer(null)).toBe(false)
    expect(shouldStepNativeChatAskAnswer(undefined)).toBe(false)
  })

  it('steps OMP through its arrow selector even when the model is routed through OpenRouter', () => {
    expect(shouldStepNativeChatAskAnswer('omp')).toBe(true)
  })

  it('steps Grok through its native question selector', () => {
    expect(shouldStepNativeChatAskAnswer('grok')).toBe(true)
  })
})

describe('Pi-family chat admission', () => {
  it.each(['pi', 'prime-agent'] as const)('keeps %s identity and shares OMP decoding', (agent) => {
    expect(isNativeChatSupportedAgent(agent)).toBe(true)
    expect(canRenderNativeChatForAgent(agent)).toBe(true)
    expect(resolveNativeChatPaneAgent(agent)).toBe(agent)
    expect(resolveNativeChatTranscriptAgent(agent)).toBe(agent)
    expect(isPiFamilyTranscriptAgent(agent)).toBe(true)
    expect(nativeChatRequiresLocalTranscript(agent)).toBe(true)
    expect(shouldStepNativeChatAskAnswer(agent)).toBe(false)
  })
})
