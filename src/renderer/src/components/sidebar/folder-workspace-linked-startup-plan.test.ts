import { describe, expect, it } from 'vitest'
import {
  buildFolderWorkspaceLinkedStartupPlan,
  resolveFolderWorkspaceLaunchDraft
} from './folder-workspace-composer-submit'
import { prependHubTaskPrompt, OMNIOS_WORK_URL } from '../../../../shared/omnios-task-binding'
import { tokenizeCustomCommandTemplate } from '../../../../shared/commit-message-prompt'

describe('buildFolderWorkspaceLinkedStartupPlan', () => {
  it.each(['claude', 'codex'] as const)(
    'binds %s folder launch and saved resume environment',
    (agent) => {
      const plan = buildFolderWorkspaceLinkedStartupPlan({
        agent,
        linkedWorkItem: {
          provider: 'backoffice',
          type: 'issue',
          number: 0,
          title: 'Make a video',
          url: 'https://app.omnisi.ai/work/btk_1234',
          hubTaskId: 'btk_1234'
        },
        note: '',
        agentCmdOverrides: {},
        agentEnv: { OMNI_TASK_ID: 'btk_wrong', CUSTOM: 'preserved' },
        platform: 'linux',
        isRemote: true
      })
      expect(plan?.env).toMatchObject({
        OMNI_TASK_ID: 'btk_1234',
        OMNIOS_URL: OMNIOS_WORK_URL,
        CUSTOM: 'preserved'
      })
      expect(plan?.launchConfig.agentEnv).toMatchObject({ OMNI_TASK_ID: 'btk_1234' })
      const command = tokenizeCustomCommandTemplate(plan?.launchCommand ?? '')
      expect(command.ok).toBe(true)
      expect(plan?.draftPrompt ?? (command.ok && command.tokens.at(-1))).toContain(
        prependHubTaskPrompt('', 'btk_1234').trim()
      )
    }
  )

  it('uses cmd quoting for configured arguments on local Windows', () => {
    const plan = buildFolderWorkspaceLinkedStartupPlan({
      agent: 'hermes',
      linkedWorkItem: {
        provider: 'github',
        type: 'issue',
        number: 42,
        title: 'Restore linked quick-create',
        url: 'https://github.com/stablyai/omni/issues/42',
        repoId: 'repo-1'
      },
      note: '',
      agentCmdOverrides: {},
      agentArgs: '--provider "value with space"',
      platform: 'win32',
      shell: 'cmd',
      isRemote: false
    })

    expect(plan?.launchCommand).toBe('hermes --tui "--provider" "value with space"')
  })
})

it('submits a person handoff in a plain folder with explicit Codex settings and task context', () => {
  const plan = buildFolderWorkspaceLinkedStartupPlan({
    agent: 'codex',
    linkedWorkItem: {
      provider: 'backoffice',
      type: 'issue',
      number: 0,
      title: 'Handoff',
      url: 'https://app.omnisi.ai/work/btk_1234',
      hubTaskId: 'btk_1234'
    },
    note: 'PERSON-FOLDER-CONTEXT',
    agentCmdOverrides: {},
    agentArgs: '-m gpt-5.5 -c model_reasoning_effort=low',
    sessionOptions: { model: 'gpt-6-astra', effort: 'xhigh' },
    sessionOptionsOverrideAgentArgs: true,
    submitPrompt: true,
    platform: 'linux',
    isRemote: true
  })
  expect(plan?.launchCommand).toContain("'-m' 'gpt-6-astra'")
  expect(plan?.launchCommand).toContain('model_reasoning_effort=xhigh')
  expect(plan?.draftPrompt).toBeUndefined()
  expect(`${plan?.launchCommand}\n${plan?.followupPrompt ?? ''}`).toContain('PERSON-FOLDER-CONTEXT')
  expect(plan?.env).toMatchObject({ OMNI_TASK_ID: 'btk_1234' })
})

describe('folder workspace agent template', () => {
  const linkedWorkItem = {
    provider: 'backoffice' as const,
    type: 'issue' as const,
    number: 0,
    title: 'Make a video',
    url: 'https://app.omnisi.ai/work/btk_1234',
    hubTaskId: 'btk_1234'
  }
  const reviewer = { name: 'Reviewer', instructions: '# Reviewer' }
  const block =
    '\n\n---\n\nStanding instructions for this session (agent template "Reviewer"; follow them throughout):\n# Reviewer'

  it('follows the fully assembled linked draft once, even with an empty note', () => {
    const plain = resolveFolderWorkspaceLaunchDraft(linkedWorkItem, '')
    const withTemplate = resolveFolderWorkspaceLaunchDraft(linkedWorkItem, '', reviewer)
    expect(plain).toBeTruthy()
    expect(withTemplate).toBe(`${plain}${block}`)
  })

  it.each([false, true])('reaches the startup plan (submitPrompt %s, SSH)', (submitPrompt) => {
    const plan = buildFolderWorkspaceLinkedStartupPlan({
      agent: 'claude',
      linkedWorkItem,
      note: 'Cut it to 30 seconds',
      agentCmdOverrides: {},
      platform: 'linux',
      isRemote: true,
      submitPrompt,
      agentTemplate: reviewer
    })
    const command = tokenizeCustomCommandTemplate(plan?.launchCommand ?? '')
    const text = plan?.draftPrompt ?? (command.ok ? command.tokens.at(-1) : '')
    expect(text?.endsWith(block)).toBe(true)
    expect(text?.split('Standing instructions for this session')).toHaveLength(2)
  })
})
