import { describe, expect, it } from 'vitest'

import {
  acpAccountHomeVariable,
  acpHandleProvider,
  acpSpawnRecipe,
  isAcpStructuredAgent
} from './acp-agent-recipes'

describe('ACP spawn recipes', () => {
  it('retains upstream agents and admits the phase-one ACP agents', () => {
    expect(isAcpStructuredAgent('grok')).toBe(true)
    expect(isAcpStructuredAgent('cursor')).toBe(true)
    expect(isAcpStructuredAgent('claude')).toBe(true)
    expect(isAcpStructuredAgent('openclaude')).toBe(true)
    expect(isAcpStructuredAgent('codex')).toBe(true)
    expect(isAcpStructuredAgent('omp')).toBe(true)
    expect(isAcpStructuredAgent('gemini')).toBe(true)
  })

  it('spawns first-party ACP for Grok and Cursor', () => {
    expect(acpSpawnRecipe('grok')).toEqual({ program: 'grok', args: ['agent', 'stdio'] })
    expect(acpSpawnRecipe('cursor')).toEqual({ program: 'agent', args: ['acp'] })
  })

  it('spawns the official ACP adapters for Claude and Codex', () => {
    expect(acpSpawnRecipe('claude')).toEqual({
      program: 'npx',
      args: ['-y', '@agentclientprotocol/claude-agent-acp@0.74.0']
    })
    expect(acpSpawnRecipe('openclaude')).toEqual(acpSpawnRecipe('claude'))
    expect(acpSpawnRecipe('codex')).toEqual({
      program: 'npx',
      args: ['-y', '@agentclientprotocol/codex-acp@1.10.0']
    })
  })

  it('returns null for an agent this Chat UI slice does not speak ACP for', () => {
    expect(acpSpawnRecipe('aider')).toBeNull()
  })

  it('maps OpenClaude onto the Claude handle and account home', () => {
    expect(acpHandleProvider('openclaude')).toBe('claude')
    expect(acpAccountHomeVariable('openclaude')).toBe('CLAUDE_CONFIG_DIR')
    expect(acpAccountHomeVariable('grok')).toBe('GROK_HOME')
    expect(acpAccountHomeVariable('cursor')).toBe('CURSOR_CONFIG_DIR')
  })
})
