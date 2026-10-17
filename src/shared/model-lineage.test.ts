import { describe, expect, it } from 'vitest'
import { isIndependentLineage, mayIssueVerdict, modelLineage } from './model-lineage'
import { ALL_TUI_AGENTS } from './tui-agent-display-names'

describe('model lineage', () => {
  it.each(ALL_TUI_AGENTS)('places %s in a known family, or refuses it a verdict', (agent) => {
    const lineage = modelLineage(agent)
    // Why both halves: an agent this build cannot place may still do the work; it may not decide
    // whether the work passed, because nothing can show it independent of what it judges.
    expect(lineage !== 'unknown' || !mayIssueVerdict(agent)).toBe(true)
    expect(mayIssueVerdict(agent)).toBe(lineage !== 'unknown' && lineage !== 'google')
  })

  it('places an Ollama model by its own name, never by the registry or publisher in front', () => {
    expect(modelLineage('ollama', 'qwen3:8b')).toBe('alibaba')
    expect(modelLineage('ollama', 'hf.co/HeYujie/Qwen3.5-35B-A3B-GGUF:Q4_K_M')).toBe('alibaba')
    expect(modelLineage('ollama', 'llama3.3:70b')).toBe('meta')
    expect(modelLineage('ollama', 'deepseek-r1:14b')).toBe('deepseek')
    expect(modelLineage('ollama', 'devstral')).toBe('mistral')
    expect(modelLineage('ollama', 'gpt-oss:20b')).toBe('openai')
    expect(modelLineage('ollama', 'gemma4:e2b-mlx')).toBe('google')
    expect(mayIssueVerdict('ollama', 'gemma4:e2b-mlx')).toBe(false)
    expect(mayIssueVerdict('ollama', 'qwen3:8b')).toBe(true)
    // A publisher named like a family does not place the model.
    expect(modelLineage('ollama', 'hf.co/qwen-fans/mystery:latest')).toBe('unknown')
    expect(mayIssueVerdict('ollama', 'phi4')).toBe(false)
  })

  it('reads the model before the agent, because one CLI routes to several providers', () => {
    expect(modelLineage('omp', 'openrouter/moonshotai/kimi-k2.5:free')).toBe('moonshot')
    expect(modelLineage('opencode', 'claude-opus-4')).toBe('anthropic')
    expect(modelLineage('opencode', 'qwen3-coder')).toBe('alibaba')
    expect(modelLineage('claude', 'gpt-5-codex')).toBe('openai')
    expect(modelLineage('claude')).toBe('anthropic')
    expect(modelLineage('opencode')).toBe('unknown')
  })

  it('places the agents the audit named', () => {
    expect(modelLineage('qwen-code')).toBe('alibaba')
    expect(modelLineage('antigravity')).toBe('google')
    expect(mayIssueVerdict('antigravity')).toBe(false)
    expect(mayIssueVerdict('qwen-code')).toBe(true)
  })

  it('places estate aliases and fast OpenRouter families by whole words only', () => {
    expect(modelLineage('gemini', 'gemini-4-argon')).toBe('google')
    expect(modelLineage(undefined, 'argon')).toBe('google')
    expect(modelLineage('codex', 'gpt-6-astra')).toBe('openai')
    expect(modelLineage(undefined, 'astra')).toBe('openai')
    expect(modelLineage(undefined, 'luna')).toBe('openai')
    expect(modelLineage(undefined, 'sol')).toBe('openai')
    expect(modelLineage(undefined, 'gpt-6.1-sol@xhigh')).toBe('openai')
    expect(modelLineage(undefined, 'terra')).toBe('openai')
    expect(modelLineage(undefined, 'claude-fable-5-1')).toBe('anthropic')
    expect(modelLineage('omp', 'deepseek/deepseek-v4.1-flash')).toBe('deepseek')
    expect(modelLineage('omp', 'xiaomi/mimo-v2.6-flash')).toBe('xiaomi')
    expect(modelLineage(undefined, 'mimo-v2.6-flash')).toBe('xiaomi')
    expect(modelLineage('openrouter', 'xiaomi/mimo-v2.6-flash')).toBe('xiaomi')
    expect(modelLineage(undefined, 'openrouter:deepseek/deepseek-v4.1-flash@high')).toBe('deepseek')
    expect(modelLineage(undefined, 'minimax-m2')).toBe('minimax')
    expect(modelLineage(undefined, 'glm-4.6')).toBe('zhipu')
    expect(mayIssueVerdict('openrouter', 'xiaomi/mimo-v2.6-flash')).toBe(true)
    // A family word inside another word places nothing.
    for (const word of ['console', 'resolve', 'lunar-lander', 'terraform', 'jargon']) {
      expect(modelLineage(undefined, word)).toBe('unknown')
      expect(modelLineage('opencode', word)).toBe('unknown')
    }
  })

  it('never calls an unplaceable seat independent', () => {
    expect(isIndependentLineage('unknown', 'anthropic')).toBe(false)
    expect(isIndependentLineage('anthropic', 'unknown')).toBe(false)
    expect(isIndependentLineage('alibaba', 'anthropic')).toBe(true)
    expect(mayIssueVerdict('opencode')).toBe(false)
    expect(mayIssueVerdict('opencode', 'claude-sonnet-4')).toBe(true)
  })
})
