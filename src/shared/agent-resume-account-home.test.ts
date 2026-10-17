import { describe, expect, it } from 'vitest'
import { pinAgentResumeAccountHome } from './agent-resume-account-home'
import { buildAgentResumeStartupPlan } from './tui-agent-resume-startup'

const ID = '1d684562-0f4e-4c7e-9b8e-0e6f3f2a1b7c'
const MANAGED =
  '/Users/maintainer/Library/Application Support/omniconsole-ide/claude-accounts/1d5b/auth/session'
const CODEX_HOME =
  '/Users/maintainer/Library/Application Support/omniconsole-ide/codex-accounts/e627/home'

function plan(args: {
  agent: 'claude' | 'codex'
  transcriptPath?: string
  agentEnv?: Record<string, string>
  agentCommand?: string
  platform?: NodeJS.Platform
}) {
  return buildAgentResumeStartupPlan(
    pinAgentResumeAccountHome({
      agent: args.agent,
      providerSession: {
        key: 'session_id',
        id: ID,
        transcriptPath: args.transcriptPath
      },
      cmdOverrides: {},
      agentArgs: '--dangerously-skip-permissions',
      agentEnv: args.agentEnv ?? {},
      ...(args.agentCommand ? { agentCommand: args.agentCommand } : {}),
      platform: args.platform ?? 'darwin'
    })
  )
}

describe('pinAgentResumeAccountHome', () => {
  it('resumes a Claude conversation under the account home that holds its transcript', () => {
    const startup = plan({
      agent: 'claude',
      transcriptPath: `${MANAGED}/projects/-w/${ID}.jsonl`,
      // The bare line a restored pane saved: it resumed in ~/.claude and found nothing.
      agentCommand: "claude '--dangerously-skip-permissions'"
    })
    expect(startup?.launchCommand).toBe(
      `CLAUDE_CONFIG_DIR='${MANAGED}' command claude '--dangerously-skip-permissions' '--resume' '${ID}'`
    )
    expect(startup?.env).toEqual({ CLAUDE_CONFIG_DIR: MANAGED })
    expect(startup?.launchConfig.agentEnv).toEqual({
      CLAUDE_CONFIG_DIR: MANAGED
    })
  })

  it('replaces a saved launch env that names a different home', () => {
    const startup = plan({
      agent: 'codex',
      transcriptPath: `${CODEX_HOME}/sessions/2026/09/30/rollout-2026-09-30T10-00-00-${ID}.jsonl`,
      agentEnv: {
        CODEX_HOME: '/Users/maintainer/.codex-other',
        ORCA_CODEX_HOME: '/x',
        KEEP: '1'
      }
    })
    expect(startup?.env).toEqual({ CODEX_HOME, KEEP: '1' })
    expect(startup?.launchCommand).toContain(`CODEX_HOME='${CODEX_HOME}' command codex`)
    expect(startup?.launchCommand).toContain(ID)
  })

  it('clears an inherited override for the default home instead of pinning it', () => {
    const startup = plan({
      agent: 'claude',
      transcriptPath: `/Users/maintainer/.claude/projects/-w/${ID}.jsonl`,
      agentEnv: { CLAUDE_CONFIG_DIR: '/Users/maintainer/.claude-account-3' }
    })
    expect(startup?.env).toEqual({})
    expect(startup?.launchCommand).toBe(
      `unset CLAUDE_CONFIG_DIR; claude '--dangerously-skip-permissions' '--resume' '${ID}'`
    )
  })

  it("leaves Codex's default home to main's spawn-time routing", () => {
    const startup = plan({
      agent: 'codex',
      transcriptPath: `/Users/maintainer/.codex/sessions/2026/09/30/rollout-x-${ID}.jsonl`
    })
    expect(startup?.launchCommand).toBe(`codex '--dangerously-skip-permissions' 'resume' '${ID}'`)
  })

  it('keeps the env pin but no inline assignment in PowerShell', () => {
    const startup = plan({
      agent: 'claude',
      transcriptPath: `C:\\Users\\sal\\.claude-account-3\\projects\\w\\${ID}.jsonl`,
      platform: 'win32'
    })
    expect(startup?.env).toEqual({
      CLAUDE_CONFIG_DIR: 'C:\\Users\\sal\\.claude-account-3'
    })
    expect(startup?.launchCommand).not.toContain('CLAUDE_CONFIG_DIR')
  })

  it('leaves a resume without a recognizable transcript path unchanged', () => {
    const args = {
      agent: 'claude' as const,
      providerSession: { key: 'session_id' as const, id: ID },
      cmdOverrides: {},
      agentCommand: 'claude',
      platform: 'darwin' as NodeJS.Platform
    }
    expect(pinAgentResumeAccountHome(args)).toBe(args)
    const other = {
      ...args,
      providerSession: {
        ...args.providerSession,
        transcriptPath: '/tmp/x.jsonl'
      }
    }
    expect(pinAgentResumeAccountHome(other)).toBe(other)
  })
})
