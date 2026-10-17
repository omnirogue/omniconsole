import { describe, expect, it } from 'vitest'
import {
  buildWorkflowGrokArgs,
  buildWorkflowGrokHomeConfig,
  buildWorkflowGrokProjectConfig,
  buildWorkflowGrokSandboxConfig,
  buildWorkflowGrokStreamArgs,
  workflowGrokEnvironment,
  workflowGrokStreamProfile,
  WORKFLOW_FROZEN_EVIDENCE_INSTRUCTIONS,
  WORKFLOW_GROK_AGENT_PROFILE,
  WORKFLOW_GROK_SANDBOX_PROFILE
} from './workflow-grok-command'
import { workflowAgentInstructions } from './workflow-agent-instructions'

const input = {
  model: 'grok-4.6-build',
  effort: 'high',
  attemptId: '83672522-9541-4b31-89f6-2ad3e39b2639',
  schema: { type: 'object', properties: {}, additionalProperties: false },
  profilePath: '/private/attempt/agent.md',
  promptPath: '/private/attempt/prompt.txt'
} as const

describe('Grok frozen workflow command', () => {
  it('removes the configured read tool and pins native session, model and effort', () => {
    const args = buildWorkflowGrokArgs(input)
    for (const [flag, value] of [
      ['--tools', 'read_file'],
      ['--disallowed-tools', 'read_file'],
      ['--model', input.model],
      ['--reasoning-effort', 'high'],
      ['--session-id', input.attemptId],
      ['--prompt-file', input.promptPath],
      ['--max-turns', '1'],
      ['--permission-mode', 'dontAsk']
    ]) {
      expect(args[args.indexOf(flag) + 1]).toBe(value)
    }
    expect(WORKFLOW_GROK_AGENT_PROFILE).toContain('injectDefaultTools: false')
    expect(WORKFLOW_GROK_AGENT_PROFILE).toContain('agentsMd: false')
  })

  it('does not replace account, auth, home or managed policy environment variables', () => {
    expect(
      Object.keys(workflowGrokEnvironment()).some((key) => /HOME|AUTH|TOKEN|MANAGED/.test(key))
    ).toBe(false)
    expect(workflowGrokEnvironment().GROK_WORKFLOWS).toBe('0')
  })

  it('constructs complete disabled MCP entries and quotes discovered names', () => {
    const config = buildWorkflowGrokProjectConfig(['z', 'a"b', 'z'])
    expect(config).toBe(
      '[mcp_servers."a\\"b"]\nenabled = false\nurl = "http://127.0.0.1:9/workflow-disabled"\n\n' +
        '[mcp_servers."z"]\nenabled = false\nurl = "http://127.0.0.1:9/workflow-disabled"\n'
    )
    expect(() => buildWorkflowGrokProjectConfig(['a\n[hooks]'])).toThrow()
  })

  it.each([{ model: '' }, { attemptId: '../escape' }, { promptPath: '' }, { effort: ' ' }])(
    'rejects incomplete resolved input %j',
    (change) => expect(() => buildWorkflowGrokArgs({ ...input, ...change })).toThrow()
  )

  it('excludes discovered skills from the request without changing the account config', () => {
    expect(buildWorkflowGrokProjectConfig([], ['review', 'build', 'review'])).toBe(
      '\n[skills]\ndisabled = ["build","review"]\n'
    )
    expect(() => buildWorkflowGrokProjectConfig([], ['bad\nskill'])).toThrow('skill name')
  })
})

describe('Grok legacy frozen argv', () => {
  it('stays byte for byte for replayed runs', () => {
    expect(buildWorkflowGrokArgs({ ...input, model: 'grok-4.6' })).toEqual([
      '--agent',
      input.profilePath,
      '--prompt-file',
      input.promptPath,
      '--model',
      'grok-4.6',
      '--reasoning-effort',
      'high',
      '--tools',
      'read_file',
      '--disallowed-tools',
      'read_file',
      '--no-subagents',
      '--disable-web-search',
      '--permission-mode',
      'dontAsk',
      '--max-turns',
      '1',
      '--json-schema',
      JSON.stringify(input.schema),
      '--system-prompt-override',
      WORKFLOW_FROZEN_EVIDENCE_INSTRUCTIONS,
      '--session-id',
      input.attemptId
    ])
    expect(WORKFLOW_GROK_AGENT_PROFILE).toContain(
      'toolConfig: { tools: [{ id: "GrokBuild:read_file" }] }'
    )
    expect(WORKFLOW_GROK_AGENT_PROFILE.endsWith(`${WORKFLOW_FROZEN_EVIDENCE_INSTRUCTIONS}\n`)).toBe(
      true
    )
  })
})

describe('Grok workflow sandbox profile', () => {
  it('limits reads to strict paths plus the attempt and account, and denies the rest', () => {
    expect(
      buildWorkflowGrokSandboxConfig({
        readOnly: ['/home/sal/.grok', '/data/attempt'],
        readWrite: ['/data/attempt/grok-home'],
        deny: ['/home/sal/.grok/sessions', '/home/sal/.grok/config.toml']
      })
    ).toBe(
      `[profiles.${WORKFLOW_GROK_SANDBOX_PROFILE}]\n` +
        'extends = "strict"\n' +
        'read_only = ["/home/sal/.grok","/data/attempt"]\n' +
        'read_write = ["/data/attempt/grok-home"]\n' +
        'deny = ["/home/sal/.grok/sessions","/home/sal/.grok/config.toml"]\n'
    )
  })

  it('refuses relative paths and control characters', () => {
    const base = { readOnly: [], readWrite: [], deny: [] }
    expect(() => buildWorkflowGrokSandboxConfig({ ...base, readOnly: ['.grok'] })).toThrow()
    expect(() => buildWorkflowGrokSandboxConfig({ ...base, deny: ['/a\nb'] })).toThrow()
  })
})

describe('Grok streamed workflow command', () => {
  const stream = { ...input, model: 'grok-4.6', cwd: '/repo', access: 'workspace-read' as const }

  it('reads the workspace through --cwd with the three read tools under the workflow sandbox', () => {
    const args = buildWorkflowGrokStreamArgs(stream)
    for (const [flag, value] of [
      ['--cwd', '/repo'],
      ['--tools', 'read_file,grep,list_dir'],
      ['--sandbox', WORKFLOW_GROK_SANDBOX_PROFILE],
      ['--permission-mode', 'dontAsk'],
      ['--output-format', 'streaming-json'],
      ['--max-turns', '24'],
      ['--model', 'grok-4.6'],
      ['--session-id', input.attemptId],
      ['--json-schema', JSON.stringify(input.schema)]
    ]) {
      expect(args[args.indexOf(flag) + 1]).toBe(value)
    }
    expect(args).not.toContain('--disallowed-tools')
    expect(args).toContain('--no-subagents')
    expect(args).toContain('--disable-web-search')
    expect(args.at(-3)).toBe(workflowAgentInstructions('workspace-read', 'schema'))
  })

  it('answers in text with no tools when frozen', () => {
    const args = buildWorkflowGrokStreamArgs({ ...stream, access: 'frozen', schema: undefined })
    expect(args).not.toContain('--json-schema')
    expect(args[args.indexOf('--disallowed-tools') + 1]).toBe('read_file')
    expect(args[args.indexOf('--max-turns') + 1]).toBe('1')
    expect(args[args.indexOf('--system-prompt-override') + 1]).toBe(
      workflowAgentInstructions('frozen', 'text')
    )
  })

  it('refuses an incomplete command', () => {
    expect(() => buildWorkflowGrokStreamArgs({ ...stream, cwd: ' ' })).toThrow()
    expect(() => buildWorkflowGrokStreamArgs({ ...stream, attemptId: 'attempt' })).toThrow()
  })

  it('configures exactly the read tools in the workspace profile', () => {
    const profile = workflowGrokStreamProfile('workspace-read', 'text')
    expect(profile).toContain(
      'toolConfig: { tools: [{ id: "GrokBuild:read_file" }, { id: "GrokBuild:grep" }, { id: "GrokBuild:list_dir" }] }'
    )
    expect(profile).toContain('tools: [read_file, grep, list_dir]')
    expect(profile).toContain('injectDefaultTools: false')
    expect(profile).toContain('mcpInheritance: none')
    expect(workflowGrokStreamProfile('frozen', 'text')).toContain('tools: [read_file]')
  })
})

describe('Grok private home config', () => {
  const account = [
    'model = "grok-4.6"',
    'mcp_servers.inline = { url = "http://example.test" }',
    '[cli]',
    'theme = "dark"',
    '[marketplace]',
    'enabled = true',
    '  [[marketplace.sources]]',
    '  url = "https://example.test"',
    '[permission]',
    'mode = "ask"',
    '[mcp_servers.github]',
    'command = "npx"',
    '  [mcp_servers.github.headers]',
    '  Authorization = "Bearer x"',
    '[memory]',
    'enabled = true',
    '[mcp_servers."notion"]',
    'url = "https://notion.test"',
    '[ui]',
    'compact = true'
  ].join('\n')

  it('keeps account settings but drops MCP servers, memory and plugin sources', () => {
    const config = buildWorkflowGrokHomeConfig(account)
    expect(config).toBe(
      [
        'model = "grok-4.6"',
        '[cli]',
        'theme = "dark"',
        '[permission]',
        'mode = "ask"',
        '[ui]',
        'compact = true',
        ''
      ].join('\n')
    )
  })

  it('disables every discovered skill', () => {
    expect(buildWorkflowGrokHomeConfig('', ['review', 'build'])).toBe(
      '\n[skills]\ndisabled = ["build","review"]\n'
    )
    expect(buildWorkflowGrokHomeConfig('[skills]\ndisabled = []', ['a'])).toBe(
      '\n[skills]\ndisabled = ["a"]\n'
    )
  })
})
