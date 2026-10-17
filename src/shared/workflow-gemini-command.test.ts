import { describe, expect, it } from 'vitest'
import {
  buildWorkflowGeminiArgs,
  buildWorkflowGeminiSystemSettings,
  readWorkflowGeminiKey,
  workflowGeminiEnvironment,
  workflowGeminiSystemPrompt,
  workflowGeminiThinkingLevel,
  WORKFLOW_GEMINI_ADMIN_POLICY
} from './workflow-gemini-command'
import { workflowAgentInstructions } from './workflow-agent-instructions'

const attemptId = '6f1c2b8e-4d7a-4e21-9c3f-2a5b7d9e0f13'
const schema = {
  type: 'object',
  properties: { markdown: { type: 'string' } },
  required: ['markdown'],
  additionalProperties: false
}

describe('Gemini workflow settings', () => {
  it('keeps the requested model instead of the silent flash substitution', () => {
    const settings = JSON.parse(
      buildWorkflowGeminiSystemSettings({ model: 'gemini-3.8-flash', effort: 'high', schema })
    )
    expect(settings.experimental).toEqual({ enableAgents: false, dynamicModelConfiguration: true })
    const alias = settings.modelConfigs.customAliases['gemini-3.8-flash']
    expect(alias.extends).toBe('chat-base-3')
    expect(alias.modelConfig.model).toBe('gemini-3.8-flash')
    expect(alias.modelConfig.generateContentConfig).toEqual({
      thinkingConfig: { thinkingLevel: 'HIGH' },
      responseMimeType: 'application/json',
      responseJsonSchema: schema
    })
  })

  it('offers only read tools and turns off every extension point', () => {
    const settings = JSON.parse(buildWorkflowGeminiSystemSettings({ model: 'gemini-3.8-flash' }))
    expect(settings.tools.core).toEqual(['read_file', 'list_directory', 'glob', 'grep_search'])
    expect(settings.security).toEqual({
      auth: { selectedType: 'gemini-api-key' },
      folderTrust: { enabled: false },
      disableYoloMode: true
    })
    expect(settings.admin).toEqual({
      mcp: { enabled: false },
      extensions: { enabled: false },
      skills: { enabled: false }
    })
    expect(settings.hooksConfig).toEqual({ enabled: false })
    expect(settings.skills).toEqual({ enabled: false })
    expect(settings.telemetry).toEqual({ enabled: false })
  })

  it('answers in text without a response schema', () => {
    const settings = JSON.parse(
      buildWorkflowGeminiSystemSettings({ model: 'gemini-3.8-flash', effort: null })
    )
    expect(
      settings.modelConfigs.customAliases['gemini-3.8-flash'].modelConfig.generateContentConfig
    ).toEqual({ thinkingConfig: { thinkingLevel: 'MEDIUM' } })
  })

  it('gives workspace reads room for many tool rounds; frozen answers keep the short cap', () => {
    const read = JSON.parse(
      buildWorkflowGeminiSystemSettings({ model: 'gemini-3.8-flash', access: 'workspace-read' })
    )
    const frozen = JSON.parse(buildWorkflowGeminiSystemSettings({ model: 'gemini-3.8-flash' }))
    expect(read.model.maxSessionTurns).toBe(80)
    expect(frozen.model).toEqual({
      maxSessionTurns: 20,
      skipNextSpeakerCheck: true,
      disableLoopDetection: true
    })
  })

  it('maps workflow effort onto the thinking level', () => {
    expect(workflowGeminiThinkingLevel('low')).toBe('LOW')
    expect(workflowGeminiThinkingLevel('medium')).toBe('MEDIUM')
    expect(workflowGeminiThinkingLevel('high')).toBe('HIGH')
    expect(workflowGeminiThinkingLevel(undefined)).toBe('MEDIUM')
  })

  it('denies writing, shell, web and agent tools at the admin tier', () => {
    for (const tool of [
      'run_shell_command',
      'write_file',
      'replace',
      'web_fetch',
      'invoke_agent'
    ]) {
      expect(WORKFLOW_GEMINI_ADMIN_POLICY).toContain(`"${tool}"`)
    }
    expect(WORKFLOW_GEMINI_ADMIN_POLICY).toContain('decision = "deny"')
    expect(WORKFLOW_GEMINI_ADMIN_POLICY).toContain('priority = 900')
  })
})

describe('Gemini workflow command', () => {
  it('streams one session with the admin policy and no extensions', () => {
    expect(
      buildWorkflowGeminiArgs({
        model: 'gemini-3.8-flash',
        attemptId,
        adminPolicyPath: '/attempt/admin-policy.toml'
      })
    ).toEqual([
      '--model',
      'gemini-3.8-flash',
      '--output-format',
      'stream-json',
      '--approval-mode',
      'default',
      '--admin-policy',
      '/attempt/admin-policy.toml',
      '--extensions',
      'none',
      '--session-id',
      attemptId,
      '--prompt',
      'Complete the task above.'
    ])
  })

  it.each([{ model: '' }, { attemptId: 'attempt-1' }, { adminPolicyPath: ' ' }])(
    'refuses incomplete input %j',
    (change) =>
      expect(() =>
        buildWorkflowGeminiArgs({
          model: 'gemini-3.8-flash',
          attemptId,
          adminPolicyPath: '/attempt/admin-policy.toml',
          ...change
        })
      ).toThrow()
  )

  it('keeps every Gemini home, setting and temp file under the attempt', () => {
    const env = workflowGeminiEnvironment({
      home: '/attempt/gemini-home',
      systemSettings: '/attempt/system-settings.json',
      systemDefaults: '/attempt/system-defaults.json',
      systemPrompt: '/attempt/system.md',
      tmp: '/attempt/tmp'
    })
    expect(env).toEqual({
      GEMINI_CLI_HOME: '/attempt/gemini-home',
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: '/attempt/system-settings.json',
      GEMINI_CLI_SYSTEM_DEFAULTS_PATH: '/attempt/system-defaults.json',
      GEMINI_CLI_TRUST_WORKSPACE: 'false',
      GEMINI_CLI_NO_RELAUNCH: 'true',
      GEMINI_SYSTEM_MD: '/attempt/system.md',
      NO_COLOR: '1',
      TMPDIR: '/attempt/tmp'
    })
    expect(Object.keys(env).some((key) => /KEY|TOKEN/.test(key))).toBe(false)
  })

  it('replaces the system prompt with the read-only workflow instructions', () => {
    expect(workflowGeminiSystemPrompt('workspace-read', 'text')).toBe(
      `${workflowAgentInstructions('workspace-read', 'text')}\n`
    )
  })
})

describe('Gemini account key', () => {
  it.each([
    ['GEMINI_API_KEY=plain-value', 'plain-value'],
    ['export GEMINI_API_KEY="quoted value"', 'quoted value'],
    ["GEMINI_API_KEY='single'", 'single'],
    ['GEMINI_API_KEY="AIzaQuoted"  # personal', 'AIzaQuoted'],
    ["GEMINI_API_KEY='AIza#hash' # note", 'AIza#hash'],
    ['OTHER=1\n# GEMINI_API_KEY=commented\nGEMINI_API_KEY=second # note', 'second'],
    [' GEMINI_API_KEY = spaced ', 'spaced']
  ])('reads %j', (dotenv, value) => {
    expect(readWorkflowGeminiKey(dotenv)).toBe(value)
  })

  it.each(['', 'GEMINI_API_KEY=', 'OTHER_GEMINI_API_KEY=x', '#GEMINI_API_KEY=x'])(
    'finds no key in %j',
    (dotenv) => {
      expect(readWorkflowGeminiKey(dotenv)).toBeUndefined()
    }
  )
})
