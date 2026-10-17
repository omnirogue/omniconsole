import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveAgentTemplates } from '../../shared/agent-templates'
import { toLinuxPath } from '../../shared/wsl-paths'
import { prepareOpenCodeLaunchConfig } from './opencode-launch-config'

const templates = resolveAgentTemplates(undefined)
const byId = (id: string) => templates.find((template) => template.id === id)!
const dirs: string[] = []

afterEach(() => {
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omni-opencode-launch-'))
  dirs.push(dir)
  return dir
}

describe('prepareOpenCodeLaunchConfig', () => {
  it('writes the template text to a file the inline config names under instructions', () => {
    const dir = scratch()
    const prepared = prepareOpenCodeLaunchConfig({
      model: 'qwen3-coder:30b',
      template: byId('reviewer'),
      contextLength: 131_072,
      instructionsDir: join(dir, 'nested'),
      platform: 'darwin'
    })
    const expectedPath = prepared.instructionsPath!
    expect(expectedPath.startsWith(join(dir, 'nested', 'omni-reviewer-'))).toBe(true)
    expect(readFileSync(expectedPath, 'utf8')).toBe(`${byId('reviewer').instructions!.trim()}\n`)
    const config = JSON.parse(prepared.env.OPENCODE_CONFIG_CONTENT) as {
      instructions: string[]
      agent?: unknown
      compaction: unknown
      provider: { ollama: { models: Record<string, { limit: { context: number } }> } }
    }
    expect(config.instructions).toEqual([expectedPath])
    expect(config.agent).toBeUndefined()
    expect(config.compaction).toEqual({ auto: false })
    expect(config.provider.ollama.models['qwen3-coder:30b']!.limit.context).toBe(131_072)
    // Why: OpenCode re-reads the file every step and sessions outlive launches, so a file is
    // never rewritten or removed: same text shares it, edited text gets a new one.
    const again = prepareOpenCodeLaunchConfig({
      model: 'qwen3-coder:30b',
      template: byId('reviewer'),
      instructionsDir: join(dir, 'nested'),
      platform: 'darwin'
    })
    expect(again.instructionsPath).toBe(expectedPath)
    const edited = prepareOpenCodeLaunchConfig({
      model: 'qwen3-coder:30b',
      template: { ...byId('reviewer'), instructions: 'Edited text' },
      instructionsDir: join(dir, 'nested'),
      platform: 'darwin'
    })
    expect(edited.instructionsPath).not.toBe(expectedPath)
    expect(readFileSync(expectedPath, 'utf8')).toBe(`${byId('reviewer').instructions!.trim()}\n`)
    expect(readdirSync(join(dir, 'nested'))).toHaveLength(2)
  })

  it('writes nothing for Default', () => {
    const dir = scratch()
    const prepared = prepareOpenCodeLaunchConfig({
      model: 'gemma3:12b',
      template: byId('default'),
      instructionsDir: join(dir, 'never-created')
    })
    expect(prepared.instructionsPath).toBeUndefined()
    const config = JSON.parse(prepared.env.OPENCODE_CONFIG_CONTENT)
    expect(config.instructions).toBeUndefined()
    expect(config.compaction).toEqual({ auto: false })
    expect(config.provider.ollama.models['gemma3:12b'].limit).toBeUndefined()
  })

  it('also names the WSL automount form of the file on Windows', () => {
    expect(toLinuxPath('C:\\Users\\sal\\AppData\\omni-x.md')).toBe(
      '/mnt/c/Users/maintainer/AppData/omni-x.md'
    )
  })

  it('names no second path when the file has no WSL form', () => {
    const prepared = prepareOpenCodeLaunchConfig({
      model: 'qwen3-coder:30b',
      template: byId('reviewer'),
      instructionsDir: scratch(),
      platform: 'win32'
    })
    expect(JSON.parse(prepared.env.OPENCODE_CONFIG_CONTENT).instructions).toEqual([
      prepared.instructionsPath
    ])
  })
})
