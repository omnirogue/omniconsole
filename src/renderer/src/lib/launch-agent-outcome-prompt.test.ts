import { describe, expect, it } from 'vitest'
import { buildAgentTabStartupCommand } from './agent-tab-startup-command'
import { composeLaunchAgentPrompt, launchAgentPrompt } from './launch-agent-outcome-prompt'
import { planLaunchAgentStartupPrompt } from './launch-agent-startup-prompt-plan'
import { hasNextOutcomeDiscovery } from '../../../shared/next-outcome-intent-instructions'
import { nextOutcomeTeamPlanConsent } from '../../../shared/next-outcome-team-plan-instructions'

const consentedAt = '2026-09-15T18:00:00.000Z'
const base = { agent: 'claude' as const, cmdOverrides: {}, platform: 'darwin' as const }

describe('launch outcome prompt', () => {
  it('leaves an ordinary launch untouched', () => {
    expect(launchAgentPrompt({ prompt: ' hello ' }, 'darwin', false)).toBe('hello')
    expect(launchAgentPrompt({}, 'darwin', false)).toBe('')
  })

  it('submits the outcome as a plain goal bound to the chosen task, with no outcome instructions', () => {
    const composed = launchAgentPrompt(
      {
        prompt: 'Context from the draft.',
        outcome: { text: 'The export ships with tests.' },
        hubTaskId: 'btk_export1'
      },
      'linux',
      false
    )
    expect(hasNextOutcomeDiscovery(composed)).toBe(false)
    expect(composed).not.toContain('outcome context')
    expect(composed).not.toContain('outcome commit')
    expect(composed).toContain('You are working omnios card btk_export1.')
    expect(composed.indexOf('omnios card btk_export1')).toBeLessThan(
      composed.indexOf('Goal: The export ships with tests.\n\nContext from the draft.')
    )
    expect(nextOutcomeTeamPlanConsent(composed)).toBeNull()
    expect(
      composeLaunchAgentPrompt({
        prompt: '',
        outcome: { text: ' Ship the export. ' },
        platform: 'darwin',
        isRemote: false
      })
    ).toBe('Goal: Ship the export.')
    const remote = composeLaunchAgentPrompt({
      prompt: '',
      outcome: { text: 'The export ships.', teamPlanConsentedAt: consentedAt },
      platform: 'linux',
      isRemote: true
    })
    expect(nextOutcomeTeamPlanConsent(remote)).toEqual({ consentedAt })
    expect(remote).toContain('`omni outcome context --json`')
  })

  it('binds a task alone without inventing an outcome', () => {
    const composed = launchAgentPrompt({ hubTaskId: 'btk_export1' }, 'darwin', false)
    expect(composed.startsWith('You are working omnios card btk_export1.')).toBe(true)
    expect(hasNextOutcomeDiscovery(composed)).toBe(false)
  })

  it('plans a team-plan launch command with one discovery prefix', () => {
    const prompt = launchAgentPrompt(
      { outcome: { text: 'The export ships.', teamPlanConsentedAt: consentedAt } },
      'darwin',
      false
    )
    const plan = planLaunchAgentStartupPrompt({
      base,
      prompt,
      promptDelivery: 'auto-submit',
      isFollowupPath: false
    })
    const command = plan.startupPlan!.launchCommand
    expect(command.split('omni-outcome-source-v1')).toHaveLength(2)
    expect(command).toContain(`consented-at=${consentedAt}`)
    expect(command).toContain('The export ships.')
    const plain = planLaunchAgentStartupPrompt({
      base,
      prompt: 'hello',
      promptDelivery: 'auto-submit',
      isFollowupPath: false
    })
    expect(plain.startupPlan!.launchCommand).not.toContain('omni-outcome-source-v1')
  })

  it('submits the outcome on a stdin-after-start agent instead of parking it as a draft', () => {
    const prompt = launchAgentPrompt(
      { outcome: { text: 'The export ships.', teamPlanConsentedAt: consentedAt } },
      'darwin',
      false
    )
    const outcomeLaunch = planLaunchAgentStartupPrompt({
      base,
      prompt,
      promptDelivery: 'auto-submit',
      isFollowupPath: true,
      submitFollowup: true
    })
    expect(outcomeLaunch.pasteDraftAfterLaunch).toBe(prompt)
    expect(outcomeLaunch.submitPastedPrompt).toBe(true)
    const goal = launchAgentPrompt({ outcome: { text: 'The export ships.' } }, 'darwin', false)
    const goalLaunch = planLaunchAgentStartupPrompt({
      base,
      prompt: goal,
      promptDelivery: 'auto-submit',
      isFollowupPath: true,
      submitFollowup: true
    })
    expect(goalLaunch.pasteDraftAfterLaunch).toBe('Goal: The export ships.')
    expect(goalLaunch.submitPastedPrompt).toBe(true)
    const typedPrompt = planLaunchAgentStartupPrompt({
      base,
      prompt: 'hello',
      promptDelivery: 'auto-submit',
      isFollowupPath: true
    })
    expect(typedPrompt.pasteDraftAfterLaunch).toBe('hello')
    expect(typedPrompt.submitPastedPrompt).toBe(false)
  })

  it('binds the chosen task through the prompt only, never an unadmitted OMNI_TASK_ID', () => {
    // src/main/pty/hub-task-launch-admission.ts fences any launch whose env names a task without a
    // console-minted launch gate, and the renderer cannot mint one — so the binding rides the prompt.
    const prompt = launchAgentPrompt(
      { outcome: { text: 'The export ships.' }, hubTaskId: 'btk_export1' },
      'darwin',
      false
    )
    const plan = planLaunchAgentStartupPrompt({
      base,
      prompt,
      promptDelivery: 'auto-submit',
      isFollowupPath: false
    })
    const startup = buildAgentTabStartupCommand(
      { agent: 'claude', launchSource: 'sidebar' },
      plan.startupPlan!,
      prompt,
      'auto-submit'
    )
    expect(prompt).toContain('You are working omnios card btk_export1.')
    expect(startup.env?.OMNI_TASK_ID).toBeUndefined()
    expect(startup.launchConfig?.agentEnv?.OMNI_TASK_ID).toBeUndefined()
  })
})
