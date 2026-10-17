import { describe, expect, it } from 'vitest'
import {
  chatBypassLaunchArgs,
  chatBypassLaunchEnv,
  chatBypassLaunchTokens,
  resolveChatLaunchDefaults
} from './chat-launch-permissions'
import { tokenizeStartupCommand } from './tui-agent-startup-shell'

describe('permission override for a chat launch', () => {
  it('keeps an explicit terminal choice unchanged even when chat is the default', () => {
    const settings = {
      experimentalNativeChat: true,
      openAgentTabsInChatByDefault: true,
      agentDefaultArgs: { claude: '--model current --permission-mode plan' }
    }
    expect(resolveChatLaunchDefaults('claude', settings, 'posix', false).agentArgs).toBe(
      settings.agentDefaultArgs.claude
    )
    expect(resolveChatLaunchDefaults('claude', settings).agentArgs).toContain(
      '--dangerously-skip-permissions'
    )
  })
  it('changes only Codex permission arguments and preserves model, effort, and other configuration', () => {
    const configured = [
      '-m',
      'current-model',
      '-c',
      'model_reasoning_effort="xhigh"',
      '-s',
      'read-only',
      '-a',
      'on-request',
      '-c',
      'sandbox_mode="read-only"',
      '--profile',
      'current-profile'
    ]
    expect(chatBypassLaunchTokens('codex', configured)).toEqual([
      '-m',
      'current-model',
      '-c',
      'model_reasoning_effort="xhigh"',
      '--profile',
      'current-profile',
      '--dangerously-bypass-approvals-and-sandbox'
    ])
    expect(configured).toContain('read-only')
  })
  it('removes Claude plan permission without changing its model or system prompt argument', () => {
    expect(
      chatBypassLaunchTokens('claude', [
        '--model',
        'current',
        '--permission-mode=plan',
        '--append-system-prompt',
        'keep exactly'
      ])
    ).toEqual([
      '--model',
      'current',
      '--append-system-prompt',
      'keep exactly',
      '--dangerously-skip-permissions'
    ])
  })
  it('keeps quoted values and puts flags before a positional delimiter', () => {
    const args = chatBypassLaunchArgs('codex', "-m current -- 'literal $HOME `value`'")
    expect(tokenizeStartupCommand(args, 'posix')).toMatchObject({
      ok: true,
      tokens: [
        '-m',
        'current',
        '--dangerously-bypass-approvals-and-sandbox',
        '--',
        'literal $HOME `value`'
      ]
    })
  })
  it('does not mutate saved environment or account selection', () => {
    const env = { GOOSE_MODE: 'approve', GOOSE_HOME: '/account', OTHER: 'keep' }
    expect(chatBypassLaunchEnv('goose', env)).toEqual({ ...env, GOOSE_MODE: 'auto' })
    expect(env.GOOSE_MODE).toBe('approve')
  })
  it('is idempotent for providers with valued bypass flags', () => {
    const args = chatBypassLaunchTokens('grok', ['--permission-mode', 'plan', '--model', 'current'])
    expect(chatBypassLaunchTokens('grok', args)).toEqual(args)
  })

  describe("OMP: the Bypass preset is explicit, never OMP's own silent default", () => {
    it('adds --yolo on the Bypass (chat-launch) path, preserving other args', () => {
      expect(chatBypassLaunchTokens('omp', ['--resume', 'abc123'])).toEqual([
        '--resume',
        'abc123',
        '--yolo'
      ])
    })

    it('resolveChatLaunchDefaults with chatLaunch=true (Bypass) yields --yolo', () => {
      const result = resolveChatLaunchDefaults(
        'omp',
        { agentDefaultArgs: { omp: '--resume' } },
        'posix',
        true
      )
      expect(result.agentArgs).toBe('--resume --yolo')
    })

    it('resolveChatLaunchDefaults with chatLaunch=false (non-Bypass) never adds --yolo, and keeps --resume', () => {
      const result = resolveChatLaunchDefaults(
        'omp',
        { agentDefaultArgs: { omp: '--resume' } },
        'posix',
        false
      )
      expect(result.agentArgs).toContain('--resume')
      expect(result.agentArgs).not.toContain('--yolo')
      expect(result.agentArgs).toContain('--config')
    })

    it('the un-flagged default launch args stay empty — OMP is never yolo just by being unconfigured', () => {
      // Why this matters: DEFAULT_TUI_AGENT_ARGS (tui-agent-launch-defaults.ts) is
      // YOLO_TUI_AGENT_ARGS itself, so OMP's Bypass flag must never live there.
      const result = resolveChatLaunchDefaults('omp', undefined, 'posix', false)
      expect(result.agentArgs).not.toContain('--yolo')
    })
  })
})
