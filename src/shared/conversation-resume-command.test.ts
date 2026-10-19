import { describe, expect, it } from 'vitest'
import {
  buildConversationResumeCommand,
  conversationProfileOf
} from './conversation-resume-command'

const ID = '2f0c9f4e-8d1a-4c7e-9b8e-0e6f3f2a1b7c'
const MANAGED =
  '/Users/maintainer/Library/Application Support/omniconsole-ide/claude-accounts/7b2e/auth/session'

describe('conversationProfileOf', () => {
  it('reads the profile a transcript lives under', () => {
    expect(conversationProfileOf('claude', `/Users/maintainer/.claude/projects/-w/${ID}.jsonl`)).toEqual({
      variable: 'CLAUDE_CONFIG_DIR',
      path: '/Users/maintainer/.claude',
      isDefault: true
    })
    expect(conversationProfileOf('claude', `${MANAGED}/projects/-w/${ID}.jsonl`)).toEqual({
      variable: 'CLAUDE_CONFIG_DIR',
      path: MANAGED,
      isDefault: false
    })
    expect(
      conversationProfileOf(
        'codex',
        `/h/app/codex-accounts/a1/home/sessions/2026/09/25/rollout-x-${ID}.jsonl`
      )
    ).toEqual({ variable: 'CODEX_HOME', path: '/h/app/codex-accounts/a1/home', isDefault: false })
    expect(
      conversationProfileOf('claude', `C:\\Users\\sal\\.claude\\projects\\w\\${ID}.jsonl`)
    ).toEqual({
      variable: 'CLAUDE_CONFIG_DIR',
      path: 'C:\\Users\\sal\\.claude',
      isDefault: true
    })
    expect(conversationProfileOf('claude', `/tmp/${ID}.jsonl`)).toBeNull()
  })
})

describe('buildConversationResumeCommand', () => {
  const base = {
    agent: 'claude' as const,
    sessionId: ID,
    executionHostId: 'local',
    hostLabel: 'mac-studio',
    platform: 'darwin' as NodeJS.Platform
  }

  it('pins a non-default Claude profile and quotes a hostile folder for the shell', () => {
    const { command, hostLabel, profile } = buildConversationResumeCommand({
      ...base,
      cwd: "/w/it's $(rm -rf ~) `x`",
      transcriptPath: `${MANAGED}/projects/-w/${ID}.jsonl`
    })
    expect(hostLabel).toBeNull()
    expect(profile?.isDefault).toBe(false)
    expect(command).toBe(
      `cd '/w/it'"'"'s $(rm -rf ~) \`x\`' && CLAUDE_CONFIG_DIR='${MANAGED}' claude --resume '${ID}'`
    )
    // Why the old JSON.stringify form was unsafe: $() and backticks stayed live inside "…".
    expect(command).not.toContain('"/w/it')
  })

  it('strips an inherited profile variable when the conversation is in the default home', () => {
    const claude = buildConversationResumeCommand({
      ...base,
      cwd: '/w',
      transcriptPath: `/Users/maintainer/.claude/projects/-w/${ID}.jsonl`
    })
    expect(claude.command).toBe(`cd '/w' && env -u CLAUDE_CONFIG_DIR claude --resume '${ID}'`)
    const codex = buildConversationResumeCommand({
      ...base,
      agent: 'codex',
      cwd: '/w',
      transcriptPath: `/Users/maintainer/.codex/sessions/2026/09/25/rollout-x-${ID}.jsonl`
    })
    expect(codex.command).toBe(
      `cd '/w' && env -u CODEX_HOME -u ORCA_CODEX_HOME codex resume '${ID}'`
    )
  })

  it('sets a non-default Codex home', () => {
    const { command } = buildConversationResumeCommand({
      ...base,
      agent: 'codex',
      cwd: null,
      transcriptPath: `/h/app/codex-accounts/a1/home/sessions/2026/09/25/rollout-x-${ID}.jsonl`
    })
    expect(command).toBe(`CODEX_HOME='/h/app/codex-accounts/a1/home' codex resume '${ID}'`)
  })

  it('quotes for cmd on Windows', () => {
    const { command } = buildConversationResumeCommand({
      ...base,
      platform: 'win32',
      cwd: 'C:\\w\\a & b',
      transcriptPath: `C:\\Users\\sal\\app\\claude-accounts\\a\\auth\\session\\projects\\w\\${ID}.jsonl`
    })
    expect(command).toBe(
      `cmd /d /s /c "cd /d ""C:\\w\\a & b"" && set ""CLAUDE_CONFIG_DIR=C:\\Users\\sal\\app\\claude-accounts\\a\\auth\\session"" && claude --resume ""${ID}"""`
    )
  })

  it('names the host a paired conversation must run on', () => {
    const { hostLabel } = buildConversationResumeCommand({
      ...base,
      executionHostId: 'runtime:env-1',
      platform: 'linux',
      cwd: '/w',
      transcriptPath: `/home/sal/.claude/projects/-w/${ID}.jsonl`
    })
    expect(hostLabel).toBe('mac-studio')
  })
})
