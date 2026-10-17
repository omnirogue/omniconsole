import { describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { resolveNewAgentSessionCommandDefaults } from './new-agent-session-command-defaults'

const settings = { nativeChatSessionOptions: { claude: { model: 'claude-opus-5-5[1m]' } } }

function resolve(
  command: string,
  overrides: Partial<Parameters<typeof resolveNewAgentSessionCommandDefaults>[0]> = {}
) {
  const resolveDefaults = vi.fn(async () => ({ model: 'claude-opus-5-5[1m]' }))
  const resolved = resolveNewAgentSessionCommandDefaults({
    agent: 'claude',
    command,
    launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} } as never,
    settings: settings as unknown as GlobalSettings,
    workspacePath: '/repo',
    platform: 'darwin',
    shell: 'posix',
    resolveDefaults,
    ...overrides
  })
  return { resolved, resolveDefaults }
}

// Run 107 of the Advertising routine (2026-10-04) resumed its thread on the agent's own
// default model while every fresh launch of the routine ran on the persisted default.
describe('resolveNewAgentSessionCommandDefaults for a routine thread resume', () => {
  // The command buildStartupForAgent hands the controller for a routine thread resume.
  const resumeCommand =
    "claude '--dangerously-skip-permissions' '--resume' 'thread-1' 'Review the routine'"

  it('carries the persisted model a fresh launch would have had, keeping the selector', async () => {
    const { resolved, resolveDefaults } = resolve(resumeCommand, { threadResume: true })
    const command = await resolved
    expect(command?.startsWith("claude '--model' 'claude-opus-5-5[1m]' ")).toBe(true)
    expect(
      command?.endsWith(
        " '--dangerously-skip-permissions' '--resume' 'thread-1' 'Review the routine'"
      )
    ).toBe(true)
    expect(resolveDefaults).toHaveBeenCalledWith(
      expect.objectContaining({ agentArgs: resumeCommand })
    )
  })

  it('leaves an explicit --model in the resume args alone', async () => {
    const explicit = "claude --model sonnet '--resume' 'thread-1' 'Go'"
    const { resolved, resolveDefaults } = resolve(explicit, { threadResume: true })
    await expect(resolved).resolves.toBe(explicit)
    expect(resolveDefaults).not.toHaveBeenCalled()
  })

  it('still leaves legacy resumes and waking sessions untouched', async () => {
    await expect(resolve(resumeCommand).resolved).resolves.toBe(resumeCommand)
    await expect(resolve(resumeCommand, { continuation: true }).resolved).resolves.toBe(
      resumeCommand
    )
    await expect(
      resolve(resumeCommand, { continuation: true, threadResume: true }).resolved
    ).resolves.toBe(resumeCommand)
  })
})
