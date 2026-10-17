import { describe, expect, it } from 'vitest'
import { resolveAgentTemplates } from './agent-templates'
import {
  buildOpenCodeLaunchConfig,
  formatModelSize,
  mergeLaunchContextEntry,
  normalizeLaunchContextMemory,
  ollamaTagFromOpenCodeModelId,
  openCodeOllamaModelId,
  rememberLaunchContext,
  resolveLocalOllamaPick,
  sameOllamaTag
} from './local-ollama-launch'
import { OPENCODE_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-opencode'
import { checkAgentLaunchPreferences } from './agent-launch-preference-check'

const templates = resolveAgentTemplates({
  overrides: { researcher: { preferredModel: 'ollama/gemma3:12b' } }
})
const byId = (id: string) => templates.find((template) => template.id === id)!

describe('local ollama launch memory', () => {
  it('keeps only well-formed entries', () => {
    expect(
      normalizeLaunchContextMemory({
        'worktree:a': { templateId: 'reviewer', ollamaModel: 'codestral:22b' },
        'folder:b': { templateId: 'Bad Id', ollamaModel: 'llama3.1:8b' },
        'folder:c': { templateId: 'reviewer', ollamaModel: 'not a tag' },
        'folder:e': { templateId: 'developer' },
        '': { templateId: 'x', ollamaModel: 'y' },
        'folder:d': 'junk'
      })
    ).toEqual({
      'worktree:a': { templateId: 'reviewer', ollamaModel: 'codestral:22b' },
      'folder:b': { templateId: 'default', ollamaModel: 'llama3.1:8b' },
      'folder:c': { templateId: 'reviewer' },
      'folder:e': { templateId: 'developer' }
    })
    expect(normalizeLaunchContextMemory(undefined)).toEqual({})
    const many = Object.fromEntries(
      Array.from({ length: 205 }, (_, i) => [
        `folder:${i}`,
        { templateId: 'default', ollamaModel: 'x:1' }
      ])
    )
    const kept = Object.keys(normalizeLaunchContextMemory(many))
    expect(kept).toHaveLength(200)
    expect(kept[0]).toBe('folder:5')
    const touched = rememberLaunchContext(
      { a: { templateId: 'default' }, b: { templateId: 'default' } },
      'a',
      { templateId: 'reviewer' }
    )
    expect(Object.keys(touched)).toEqual(['b', 'a'])
  })

  it('merges one target on top of the current memory and forgets on null', () => {
    const base = { 'folder:a': { templateId: 'reviewer', ollamaModel: 'qwen3-coder:30b' } }
    expect(mergeLaunchContextEntry(base, 'folder:a', { ollamaModel: 'gemma3:12b' })).toEqual({
      'folder:a': { templateId: 'reviewer', ollamaModel: 'gemma3:12b' }
    })
    expect(mergeLaunchContextEntry(base, 'folder:a', { templateId: 'developer' })).toEqual({
      'folder:a': { templateId: 'developer', ollamaModel: 'qwen3-coder:30b' }
    })
    expect(mergeLaunchContextEntry(base, 'folder:b', { ollamaModel: 'gemma3:12b' })).toEqual({
      ...base,
      'folder:b': { templateId: 'default', ollamaModel: 'gemma3:12b' }
    })
    expect(mergeLaunchContextEntry(base, 'folder:a', null)).toEqual({})
    expect(mergeLaunchContextEntry(undefined, 'folder:a', { templateId: 'reviewer' })).toEqual({
      'folder:a': { templateId: 'reviewer' }
    })
  })

  it('validates entries before applying the cap, so junk never evicts a real one', () => {
    const junk = Object.fromEntries(Array.from({ length: 200 }, (_, n) => [`junk-${n}`, {}]))
    const memory = normalizeLaunchContextMemory({
      'folder:a': { templateId: 'reviewer', ollamaModel: 'qwen3-coder:30b' },
      ...junk
    })
    expect(memory).toEqual({
      'folder:a': { templateId: 'reviewer', ollamaModel: 'qwen3-coder:30b' }
    })
  })
})

describe('resolveLocalOllamaPick', () => {
  const installedTags = ['qwen3-coder:30b', 'gemma3:12b']

  it('prefers what the workspace used last, even when it is no longer installed', () => {
    const pick = resolveLocalOllamaPick({
      memory: { 'worktree:a': { templateId: 'reviewer', ollamaModel: 'codestral:22b' } },
      workspaceKey: 'worktree:a',
      templates,
      installedTags
    })
    expect(pick.template.id).toBe('reviewer')
    expect(pick.model).toBe('codestral:22b')
    expect(pick.modelSource).toBe('remembered')
    expect(pick.installed).toBe(false)
  })

  it('matches an untagged preference or memory to its :latest entry', () => {
    const pick = resolveLocalOllamaPick({
      memory: { 'folder:x': { templateId: 'default', ollamaModel: 'gemma3' } },
      workspaceKey: 'folder:x',
      templates,
      installedTags: ['aaa:latest', 'gemma3:latest']
    })
    expect(pick).toMatchObject({
      model: 'gemma3:latest',
      modelSource: 'remembered',
      installed: true
    })
    expect(sameOllamaTag('localhost:5000/dev/coder', 'localhost:5000/dev/coder:latest')).toBe(true)
    expect(sameOllamaTag('a:1', 'a:2')).toBe(false)
  })

  it('uses the template preference when another template is chosen explicitly', () => {
    const pick = resolveLocalOllamaPick({
      memory: { 'worktree:a': { templateId: 'reviewer', ollamaModel: 'qwen3-coder:30b' } },
      workspaceKey: 'worktree:a',
      templates,
      installedTags,
      templateId: 'researcher'
    })
    expect(pick.model).toBe('gemma3:12b')
    expect(pick.modelSource).toBe('template')
  })

  it('falls back to the remembered installed model, then the first installed, then none', () => {
    const fromMemory = resolveLocalOllamaPick({
      memory: { 'worktree:a': { templateId: 'reviewer', ollamaModel: 'qwen3-coder:30b' } },
      workspaceKey: 'worktree:a',
      templates,
      installedTags,
      templateId: 'developer'
    })
    expect(fromMemory).toMatchObject({ model: 'qwen3-coder:30b', modelSource: 'remembered' })
    const first = resolveLocalOllamaPick({
      memory: {},
      workspaceKey: 'folder:x',
      templates,
      installedTags
    })
    expect(first).toMatchObject({
      model: 'qwen3-coder:30b',
      modelSource: 'first-installed',
      installed: true
    })
    const none = resolveLocalOllamaPick({
      memory: {},
      workspaceKey: 'folder:x',
      templates,
      installedTags: []
    })
    expect(none).toMatchObject({ model: null, modelSource: 'none', installed: false })
  })
})

describe('OpenCode launch config', () => {
  it('declares the launched model and the template text as instructions, never an agent', () => {
    const config = buildOpenCodeLaunchConfig({
      model: 'qwen3-coder:30b',
      template: byId('reviewer'),
      contextLength: 4096,
      instructionsPaths: ['/tmp/omni-reviewer.md']
    })
    expect(config.model).toBe('ollama/qwen3-coder:30b')
    expect(config).toMatchObject({
      provider: {
        ollama: {
          npm: '@ai-sdk/openai-compatible',
          options: { baseURL: 'http://localhost:11434/v1' },
          models: {
            'qwen3-coder:30b': { name: 'qwen3-coder:30b', limit: { context: 4096, output: 8192 } }
          }
        }
      },
      instructions: ['/tmp/omni-reviewer.md'],
      compaction: { auto: false }
    })
    // Why: an agent prompt would replace OpenCode's system prompt, and an unknown agent gets deny-by-default permissions.
    expect(config.agent).toBeUndefined()
    expect(() =>
      buildOpenCodeLaunchConfig({ model: 'qwen3-coder:30b', template: byId('reviewer') })
    ).toThrow(/instructions file/)
  })

  it('adds no instructions for Default', () => {
    const config = buildOpenCodeLaunchConfig({ model: 'gemma3:12b', template: byId('default') })
    expect(config.agent).toBeUndefined()
    expect(config.instructions).toBeUndefined()
    expect(config.compaction).toEqual({ auto: false })
  })

  it.each([undefined, 0, -1, Number.NaN, Infinity, 4096.5])(
    'does not overwrite the user model context when it is unknown or invalid (%s)',
    (contextLength) => {
      const config = buildOpenCodeLaunchConfig({
        model: 'gemma4:e2b-mlx',
        template: byId('default'),
        contextLength
      })
      expect(config).toMatchObject({
        provider: { ollama: { models: { 'gemma4:e2b-mlx': { name: 'gemma4:e2b-mlx' } } } }
      })
      expect(JSON.stringify(config)).not.toContain('"limit"')
    }
  )

  it('retains the measured 131072 context instead of replacing it with 65536', () => {
    const config = buildOpenCodeLaunchConfig({
      model: 'gemma4:e2b-mlx',
      template: byId('default'),
      contextLength: 131_072
    })
    expect(config).toMatchObject({
      provider: {
        ollama: { models: { 'gemma4:e2b-mlx': { limit: { context: 131_072, output: 8192 } } } }
      }
    })
  })

  it('round-trips model ids and trims a custom base URL', () => {
    expect(openCodeOllamaModelId('llama3.1:8b')).toBe('ollama/llama3.1:8b')
    expect(ollamaTagFromOpenCodeModelId('ollama/llama3.1:8b')).toBe('llama3.1:8b')
    expect(ollamaTagFromOpenCodeModelId('openrouter/x')).toBeNull()
    expect(ollamaTagFromOpenCodeModelId('ollama/hf.co/org/model:q4')).toBe('hf.co/org/model:q4')
    expect(ollamaTagFromOpenCodeModelId('ollama/localhost:5000/dev/coder:30b')).toBe(
      'localhost:5000/dev/coder:30b'
    )
    const config = buildOpenCodeLaunchConfig({
      model: 'llama3.1:8b',
      template: byId('default'),
      baseUrl: 'http://127.0.0.1:11434/v1/'
    })
    expect(
      (config.provider as { ollama: { options: { baseURL: string } } }).ollama.options.baseURL
    ).toBe('http://127.0.0.1:11434/v1')
  })

  it('is accepted by launch-preference validation for opencode', () => {
    expect(OPENCODE_SESSION_OPTION_CATALOG.modelApply.launchArgs!('ollama/x')).toEqual([
      '--model',
      'ollama/x'
    ])
    expect(checkAgentLaunchPreferences('opencode', { model: 'ollama/qwen3-coder:30b' }).ok).toBe(
      true
    )
  })

  it('formats sizes for the picker', () => {
    expect(formatModelSize(18 * 1_073_741_824)).toBe('18 GB')
    expect(formatModelSize(4.9 * 1_073_741_824)).toBe('4.9 GB')
    expect(formatModelSize(0)).toBe('')
  })
})
