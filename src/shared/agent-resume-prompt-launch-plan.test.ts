import { describe, expect, it } from 'vitest'
import { applyAgentBackgroundResumePlan } from './agent-resume-prompt-launch-plan'
import { buildAgentStartupPlan } from './tui-agent-startup'

const providerSession = { key: 'session_id' as const, id: 'thread-1' }

describe('applyAgentBackgroundResumePlan', () => {
  it('turns a fresh Codex launch into a resume that still carries the prompt', () => {
    const fresh = buildAgentStartupPlan({
      agent: 'codex',
      prompt: "Review today's ads",
      cmdOverrides: {},
      platform: 'darwin',
      agentArgs: '--dangerously-bypass-approvals-and-sandbox',
      agentEnv: { CODEX_HOME: '/homes/acct' }
    })
    const plan = applyAgentBackgroundResumePlan({ providerSession }, fresh, {
      platform: 'darwin',
      prompt: "Review today's ads"
    })
    expect(plan?.launchCommand).toBe(
      "codex '--dangerously-bypass-approvals-and-sandbox' 'resume' 'thread-1' 'Review today'\"'\"'s ads'"
    )
    expect(plan?.startupCommandDelivery).toBe('shell-ready')
    expect(plan?.env).toEqual({ CODEX_HOME: '/homes/acct' })
    expect(plan?.launchConfig.agentArgs).toBe('--dangerously-bypass-approvals-and-sandbox')
  })

  it('turns a fresh Claude launch into --resume with the prompt positional', () => {
    const fresh = buildAgentStartupPlan({
      agent: 'claude',
      prompt: 'Continue',
      cmdOverrides: {},
      platform: 'linux',
      agentArgs: '--dangerously-skip-permissions'
    })
    const plan = applyAgentBackgroundResumePlan({ providerSession }, fresh, {
      platform: 'linux',
      prompt: 'Continue'
    })
    expect(plan?.launchCommand).toBe(
      "claude '--dangerously-skip-permissions' '--resume' 'thread-1' 'Continue'"
    )
  })

  it('keeps the fresh plan when nothing was requested or the agent cannot resume by id', () => {
    const fresh = buildAgentStartupPlan({
      agent: 'codex',
      prompt: 'x',
      cmdOverrides: {},
      platform: 'darwin'
    })
    expect(
      applyAgentBackgroundResumePlan(undefined, fresh, { platform: 'darwin', prompt: 'x' })
    ).toBe(fresh)
    const amp = buildAgentStartupPlan({
      agent: 'amp',
      prompt: 'x',
      cmdOverrides: {},
      platform: 'darwin'
    })
    expect(
      applyAgentBackgroundResumePlan({ providerSession }, amp, { platform: 'darwin', prompt: 'x' })
    ).toBe(amp)
    expect(
      applyAgentBackgroundResumePlan({ providerSession }, null, { platform: 'darwin', prompt: 'x' })
    ).toBeNull()
  })
})

describe('applyAgentBackgroundResumePlan with launch preferences', () => {
  it('keeps the routine model and effort flags on the resumed Codex command', () => {
    const fresh = buildAgentStartupPlan({
      agent: 'codex',
      prompt: 'Run the routine',
      cmdOverrides: {},
      platform: 'darwin',
      agentArgs: '--dangerously-bypass-approvals-and-sandbox',
      sessionOptions: { model: 'gpt-6-astra', effort: 'xhigh' },
      sessionOptionsOverrideAgentArgs: true,
      bypassShellFunctions: true
    })
    expect(fresh?.launchCommand).toContain("'-m' 'gpt-6-astra'")
    expect(fresh?.launchCommand).toContain("'-c' 'model_reasoning_effort=xhigh'")
    const plan = applyAgentBackgroundResumePlan({ providerSession }, fresh, {
      platform: 'darwin',
      prompt: 'Run the routine'
    })
    expect(plan?.launchCommand).toBe(
      "command codex '--dangerously-bypass-approvals-and-sandbox' '-m' 'gpt-6-astra' '-c' 'model_reasoning_effort=xhigh' 'resume' 'thread-1' 'Run the routine'"
    )
    // Why: the sleeping-session relaunch config still keeps only explicit user args.
    expect(plan?.launchConfig.agentCommand).not.toContain('gpt-6-astra')
  })
})
