import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { buildQuickComposerStartup, type QuickComposerStartupInput } from './quick-startup-plan'
import { assembleQuickComposerTexts } from './quick-composer-texts'
import { prependHubTaskPrompt, OMNIOS_WORK_URL } from '../../../../shared/omnios-task-binding'
import { tokenizeCustomCommandTemplate } from '../../../../shared/commit-message-prompt'

const input: QuickComposerStartupInput = {
  agent: 'claude',
  prompt: 'Create the product video',
  draftPrompt: null,
  settings: null,
  repoConnectionId: null,
  platform: 'darwin',
  shell: undefined,
  isRemote: false,
  telemetrySource: 'sidebar',
  hubTaskId: 'btk_1234'
}

describe('quick composer hub launch binding', () => {
  it('binds the command and saved launch environment for an admitted card', () => {
    const result = buildQuickComposerStartup(input)
    const command = tokenizeCustomCommandTemplate(result.startupPlan?.launchCommand ?? '')
    expect(command.ok && command.tokens.at(-1)).toContain(
      prependHubTaskPrompt(input.prompt, input.hubTaskId)
    )
    expect(result.startupPlan?.env).toMatchObject({
      OMNI_TASK_ID: 'btk_1234',
      OMNIOS_URL: OMNIOS_WORK_URL
    })
    expect(result.startupPlan?.launchConfig.agentEnv).toMatchObject({
      OMNI_TASK_ID: 'btk_1234',
      OMNIOS_URL: OMNIOS_WORK_URL
    })
    expect(result.backendStartup?.env).toMatchObject({ OMNI_TASK_ID: 'btk_1234' })
  })

  it.each(['claude', 'codex'] as const)('preserves the card in %s draft delivery', (agent) => {
    const result = buildQuickComposerStartup({
      ...input,
      agent,
      prompt: '',
      draftPrompt: 'Review this draft before starting',
      platform: 'linux',
      repoConnectionId: 'ssh-1',
      isRemote: true
    })
    const plan = result.startupPlan
    if (agent === 'codex') {
      expect(plan?.launchCommand).not.toContain('You are working omnios card')
    }
    expect(plan?.env).toMatchObject({ OMNI_TASK_ID: 'btk_1234' })
    const command = tokenizeCustomCommandTemplate(plan?.launchCommand ?? '')
    expect(command.ok).toBe(true)
    expect(plan?.draftPrompt ?? (command.ok && command.tokens.at(-1))).toContain(
      prependHubTaskPrompt('Review this draft before starting', input.hubTaskId)
    )
  })

  it('canonical card variables override configured environment while preserving unrelated values', () => {
    const result = buildQuickComposerStartup({
      ...input,
      settings: {
        agentDefaultEnv: { claude: { OMNI_TASK_ID: 'btk_wrong', CUSTOM: 'kept' } }
      } as unknown as QuickComposerStartupInput['settings']
    })
    expect(result.startupPlan?.env).toMatchObject({ OMNI_TASK_ID: 'btk_1234', CUSTOM: 'kept' })
  })

  it('keeps an ad hoc launch unbound and does not add protocol text', () => {
    const result = buildQuickComposerStartup({ ...input, hubTaskId: undefined })
    expect(result.startupPlan?.launchCommand).not.toContain('omni outcome context --json')
    expect(result.startupPlan?.env).not.toHaveProperty('OMNI_TASK_ID')
    expect(result.startupPlan?.launchCommand).not.toContain('You are working omnios card')
  })

  it('does not launch an agent when the operator chose none', () => {
    expect(buildQuickComposerStartup({ ...input, agent: null }).startupPlan).toBeNull()
  })
})

it('submits a handed-off Codex instruction with the selected model and effort over saved defaults', () => {
  const result = buildQuickComposerStartup({
    ...input,
    agent: 'codex',
    prompt: '',
    draftPrompt: 'PERSON-TO-AGENT-CONTEXT',
    launchOptions: { preferences: { model: 'gpt-6-astra', effort: 'xhigh' }, submitPrompt: true },
    settings: {
      agentDefaultArgs: { codex: '-m gpt-5.5 -c model_reasoning_effort=low' }
    } as QuickComposerStartupInput['settings']
  })
  expect(result.startupPlan?.agent).toBe('codex')
  expect(result.startupPlan?.launchCommand).toContain("'-m' 'gpt-6-astra'")
  expect(result.startupPlan?.launchCommand).toContain('model_reasoning_effort=xhigh')
  expect(result.startupPlan?.launchCommand).not.toContain('gpt-5.5')
  expect(result.startupPlan?.draftPrompt).toBeUndefined()
  expect(
    `${result.startupPlan?.launchCommand}\n${result.startupPlan?.followupPrompt ?? ''}`
  ).toContain('PERSON-TO-AGENT-CONTEXT')
})

it('rejects unsupported effort before creating a launch command', () => {
  expect(() =>
    buildQuickComposerStartup({
      ...input,
      agent: 'codex',
      launchOptions: { preferences: { model: 'gpt-6-astra', effort: 'invented' } }
    })
  ).toThrow('does not support effort')
})

describe('quick composer agent template', () => {
  const lastToken = (launchCommand: string | undefined): string => {
    const command = tokenizeCustomCommandTemplate(launchCommand ?? '')
    return command.ok ? (command.tokens.at(-1) ?? '') : ''
  }

  it('sends the typed prompt first and the chosen template after it, once', () => {
    const result = buildQuickComposerStartup({
      ...input,
      launchOptions: { agentTemplateId: 'reviewer' }
    })
    const sent = lastToken(result.startupPlan?.launchCommand)
    expect(sent.startsWith(prependHubTaskPrompt('Create the product video', 'btk_1234'))).toBe(true)
    expect(sent.split('Standing instructions for this session')).toHaveLength(2)
    expect(sent).toMatch(
      /Create the product video\n\n---\n\nStanding instructions[^\n]*\n# Reviewer/
    )
  })

  it('puts the template after a draft too', () => {
    const drafted = buildQuickComposerStartup({
      ...input,
      agent: 'claude',
      hubTaskId: undefined,
      prompt: '',
      draftPrompt: 'Review this draft',
      launchOptions: { agentTemplateId: 'reviewer' }
    })
    expect(
      drafted.startupPlan?.draftPrompt ?? lastToken(drafted.startupPlan?.launchCommand)
    ).toMatch(/^Review this draft\n\n---\n\nStanding instructions[\s\S]*# Reviewer/)
  })

  it('sends the plain template when nothing was typed, and nothing with Default', () => {
    const empty = buildQuickComposerStartup({
      ...input,
      hubTaskId: undefined,
      prompt: '',
      launchOptions: { agentTemplateId: 'reviewer' }
    })
    expect(lastToken(empty.startupPlan?.launchCommand)).toMatch(/^# Reviewer\nRead-only/)
    const plain = buildQuickComposerStartup({ ...input, hubTaskId: undefined, prompt: '' })
    expect(plain.startupPlan?.launchCommand).not.toContain('Reviewer')
  })
})

describe('assembleQuickComposerTexts', () => {
  const reviewer = { name: 'Reviewer', instructions: '# Reviewer' }

  it('gives the launch draft the task binding and the template exactly once', () => {
    const texts = assembleQuickComposerTexts({
      prompt: '',
      draftPrompt: 'Linked issue #12',
      hubTaskId: 'btk_1234',
      agentTemplate: reviewer
    })
    expect(texts.draftPrompt).toBe(
      `${prependHubTaskPrompt('Linked issue #12', 'btk_1234')}${block}`
    )
    expect(texts.prompt).toBe('')
  })

  it('leaves both texts alone with Default', () => {
    expect(
      assembleQuickComposerTexts({ prompt: 'Do it', draftPrompt: null, agentTemplate: null })
    ).toEqual({ prompt: 'Do it', draftPrompt: null })
  })
})

const block =
  '\n\n---\n\nStanding instructions for this session (agent template "Reviewer"; follow them throughout):\n# Reviewer'

it('preserves an explicit Claude effort environment in a terminal quick launch', () => {
  const result = buildQuickComposerStartup({
    ...input,
    settings: {
      ...getDefaultSettings('/tmp'),
      experimentalNativeChat: true,
      openAgentTabsInChatByDefault: false,
      agentDefaultEnv: { claude: { CLAUDE_CODE_EFFORT_LEVEL: 'low' } },
      nativeChatSessionOptions: {
        claude: { model: 'opus', valuesByModel: { opus: { effort: 'medium' } } }
      }
    }
  })
  expect(result.startupPlan?.env).toMatchObject({ CLAUDE_CODE_EFFORT_LEVEL: 'low' })
  expect(result.startupPlan?.launchCommand).not.toContain('--effort')
  expect(result.startupPlan?.sessionOptions).toBeUndefined()
})
