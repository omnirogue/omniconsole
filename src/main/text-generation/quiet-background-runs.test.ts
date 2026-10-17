import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLAUDE_ISOLATED_HEADLESS_ARGS } from '../../shared/claude-isolated-headless'
import {
  buildWorkflowClaudeArgs,
  WORKFLOW_CLAUDE_STREAM_ENVIRONMENT
} from '../../shared/workflow-claude-command'
import { discoverCommitMessageModelsRemote } from './commit-message-text-generation'
import { withPlatform } from './commit-message-text-generation-test-harness'
import {
  _resetQuietBackgroundAgentRunsReaderForTests,
  quietBackgroundAgentPlan,
  setQuietBackgroundAgentRunsReader
} from './quiet-background-runs'
import {
  generateAssistedBriefText,
  generateCommitMessage,
  generateSessionSummaryText
} from './source-control-text-generation-requests'
import type { SpawnSourceControlAgent } from './source-control-text-generation-types'

const FROZEN_ENV = { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' }

function capturingSpawn(stdout: string) {
  const spawned: Parameters<SpawnSourceControlAgent>[0][] = []
  const spawnAgent: SpawnSourceControlAgent = (input) => {
    spawned.push(input)
    const listeners = new Map<string, (value: unknown) => void>()
    const child = {
      pid: 321,
      kill: vi.fn(),
      stdout: { on: vi.fn((event, callback) => listeners.set(`stdout:${event}`, callback)) },
      stderr: { on: vi.fn((event, callback) => listeners.set(`stderr:${event}`, callback)) },
      stdin: { on: vi.fn(), end: vi.fn() },
      on: vi.fn((event, callback) => listeners.set(event, callback))
    }
    queueMicrotask(() => {
      listeners.get('stdout:data')?.(Buffer.from(stdout))
      listeners.get('close')?.(0)
    })
    return child as never
  }
  return { spawned, spawnAgent }
}

const claude = { agentId: 'claude' as const, model: 'haiku' }
const local = { kind: 'local' as const, cwd: '/tmp/summarizer' }

afterEach(() => {
  _resetQuietBackgroundAgentRunsReaderForTests()
})

describe('quiet background agent runs', () => {
  it('is the same isolation recipe the frozen workflow argv carries', () => {
    const workflow = buildWorkflowClaudeArgs({
      model: 'sonnet',
      attemptId: 'attempt-1',
      schema: { type: 'object' }
    })
    const start = workflow.indexOf('--strict-mcp-config')
    expect(workflow.slice(start, start + CLAUDE_ISOLATED_HEADLESS_ARGS.length)).toEqual([
      ...CLAUDE_ISOLATED_HEADLESS_ARGS
    ])
    expect(WORKFLOW_CLAUDE_STREAM_ENVIRONMENT).toEqual(FROZEN_ENV)
  })

  it('runs the session summarizer tool-free, hook-free and transcript-free, prompt on stdin', async () => {
    const { spawned, spawnAgent } = capturingSpawn('Summary line')
    await expect(
      generateSessionSummaryText({
        prompt: 'Summarize this transcript',
        params: claude,
        target: { ...local, env: { PATH: '/usr/bin', HOME: '/home/tester' } },
        spawnAgent
      })
    ).resolves.toMatchObject({ success: true })
    const [run] = spawned
    expect(run?.args).toEqual([
      '-p',
      '--output-format',
      'text',
      '--model',
      'haiku',
      '--permission-mode',
      'plan',
      ...CLAUDE_ISOLATED_HEADLESS_ARGS,
      '--tools',
      ''
    ])
    expect(run?.args).not.toContain('Summarize this transcript')
    expect(run?.stdinMode).toBe('pipe')
    expect(run?.env).toEqual({ PATH: '/usr/bin', HOME: '/home/tester', ...FROZEN_ENV })
  })

  it('runs the commit-message Claude spec with the recipe and no tools', async () => {
    const { spawned, spawnAgent } = capturingSpawn('feat: add greeting')
    await generateCommitMessage({
      context: { branch: 'main', stagedSummary: 'M\tREADME.md', stagedPatch: '+hello' },
      params: { agentId: 'claude', model: 'sonnet' },
      target: { kind: 'local', cwd: '/repo' },
      spawnAgent
    })
    expect(spawned[0]?.args).toEqual(
      expect.arrayContaining([...CLAUDE_ISOLATED_HEADLESS_ARGS, '--tools', ''])
    )
    expect(spawned[0]?.args.slice(-2)).toEqual(['--tools', ''])
    expect(spawned[0]?.env).toMatchObject(FROZEN_ENV)
  })

  it('keeps read tools for runs that research the workspace, and the person’s own flags win', async () => {
    const { spawned, spawnAgent } = capturingSpawn('Brief')
    await generateAssistedBriefText({
      prompt: 'Draft a brief',
      params: { ...claude, agentArgs: '--setting-sources user' },
      target: local,
      spawnAgent
    })
    const args = spawned[0]?.args ?? []
    expect(args).not.toContain('--tools')
    expect(args.filter((arg) => arg === '--setting-sources')).toHaveLength(1)
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('user')
    expect(args).toContain('--strict-mcp-config')
    expect(args).toContain('--no-session-persistence')
  })

  it('sends a remote host the recipe without the inline MCP config a Windows batch shim refuses', async () => {
    const execute = vi.fn(async (_plan: { args: string[] }, _cwd: string, _timeoutMs: number) => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
      timedOut: false
    }))
    await discoverCommitMessageModelsRemote('claude', '/remote/repo', execute)
    const args = execute.mock.calls[0]?.[0].args ?? []
    // Why: `--strict-mcp-config` with no `--mcp-config` already loads no MCP server at all.
    expect(args).toEqual([
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--strict-mcp-config',
      '--setting-sources',
      '',
      '--disable-slash-commands',
      '--no-session-persistence'
    ])
    // The relay quotes each token for cmd.exe on a Windows host and refuses these characters.
    expect(args.filter((arg) => /[&|<>^"%!\r\n]/.test(arg))).toEqual([])
    const plan = { binary: 'claude', args: ['-p'], stdinPayload: 'x', label: 'Claude' }
    const remote = quietBackgroundAgentPlan('claude', plan, 'commit-message', { remote: true })
    expect(remote.args).toEqual([
      '-p',
      '--strict-mcp-config',
      '--setting-sources',
      '',
      '--disable-slash-commands',
      '--no-session-persistence',
      '--tools',
      ''
    ])
    // This Mac keeps the verified recipe, inline empty MCP config included.
    const local = quietBackgroundAgentPlan('claude', plan, 'commit-message', { remote: false })
    expect(local.args).toEqual(['-p', ...CLAUDE_ISOLATED_HEADLESS_ARGS, '--tools', ''])
  })

  it('leaves other agents, a Windows host and the kill switch untouched', async () => {
    const plan = { binary: 'claude', args: ['-p'], stdinPayload: 'x', label: 'Claude' }
    expect(quietBackgroundAgentPlan('codex', plan, 'commit-message', { remote: false })).toBe(plan)
    expect(
      withPlatform('win32', () =>
        quietBackgroundAgentPlan('claude', plan, 'commit-message', { remote: false })
      )
    ).toBe(plan)
    setQuietBackgroundAgentRunsReader(() => false)
    expect(quietBackgroundAgentPlan('claude', plan, 'model-discovery', { remote: false })).toBe(
      plan
    )
    const { spawned, spawnAgent } = capturingSpawn('Summary line')
    await generateSessionSummaryText({ prompt: 'p', params: claude, target: local, spawnAgent })
    expect(spawned[0]?.args).not.toContain('--setting-sources')
    expect(spawned[0]?.env).toBeUndefined()
  })
})
