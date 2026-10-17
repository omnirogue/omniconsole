import { describe, expect, it } from 'vitest'
import {
  buildWorkflowCodexArgs,
  buildWorkflowCodexStreamArgs,
  parseWorkflowCodexSessionEvidence,
  WORKFLOW_CODEX_PERMISSION_PROFILE
} from './workflow-codex-command'

const expected = {
  sessionId: 'native-id',
  model: 'gpt-5.6-sol',
  effort: 'low',
  cliVersion: '0.155.1'
}
const metadata = {
  type: 'session_meta',
  payload: {
    id: expected.sessionId,
    session_id: expected.sessionId,
    cli_version: expected.cliVersion,
    originator: 'codex_exec',
    model_provider: 'openai'
  }
}
const context = {
  type: 'turn_context',
  payload: {
    model: expected.model,
    effort: expected.effort,
    turn_id: 'native-turn',
    approval_policy: 'never',
    sandbox_policy: { type: 'read-only' }
  }
}
const encode = (value: unknown[]) => value.map((row) => JSON.stringify(row)).join('\n')

describe('Codex frozen workflow command and session evidence', () => {
  it('retains native evidence, restrictive sandbox and explicit model/effort without bypassing rules', () => {
    const args = buildWorkflowCodexArgs({
      ...expected,
      schemaPath: '/a/schema.json',
      instructionsPath: '/a/prompt.md'
    })
    expect(args).not.toContain('--ephemeral')
    expect(args).not.toContain('--ignore-rules')
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(args[args.indexOf('-s') + 1]).toBe('read-only')
    expect(args[args.indexOf('--model') + 1]).toBe(expected.model)
    expect(args).toContain('agents.enabled=false')
    expect(args).toContain('skills.include_instructions=false')
  })

  it('reads only matching native session evidence', () => {
    expect(parseWorkflowCodexSessionEvidence(encode([metadata, context]), expected)).toEqual({
      ...expected,
      turnId: 'native-turn'
    })
  })

  it.each([
    { model: 'substituted-model' },
    { effort: 'high' },
    { approval_policy: 'on-request' },
    { sandbox_policy: { type: 'danger-full-access' } },
    { turn_id: '' }
  ])('refuses mismatched context %j', (change) => {
    expect(() =>
      parseWorkflowCodexSessionEvidence(
        encode([metadata, { ...context, payload: { ...context.payload, ...change } }]),
        expected
      )
    ).toThrow()
  })

  it('refuses another account provider/session, duplicate turns and truncated evidence', () => {
    for (const change of [
      { id: 'other' },
      { model_provider: 'custom' },
      { cli_version: 'changed' },
      { cli_version: '0.155.0' },
      { cli_version: 42 }
    ]) {
      expect(() =>
        parseWorkflowCodexSessionEvidence(
          encode([{ ...metadata, payload: { ...metadata.payload, ...change } }, context]),
          expected
        )
      ).toThrow()
    }
    expect(() =>
      parseWorkflowCodexSessionEvidence(encode([metadata, context, context]), expected)
    ).toThrow()
    expect(() =>
      parseWorkflowCodexSessionEvidence(`${encode([metadata, context])}{`, expected)
    ).toThrow()
  })
})

describe('Codex permission profile evidence', () => {
  const withProfile = (entries: unknown) => ({
    ...context,
    payload: { ...context.payload, permission_profile: { file_system: { entries } } }
  })

  it('accepts a profile that only reads and denies', () => {
    const entries = [
      { path: { type: 'path', path: '/home/sal' }, access: 'deny' },
      { path: { type: 'path', path: '/home/sal/repo' }, access: 'read' },
      { path: { type: 'special', value: { kind: 'root' } }, access: 'read' }
    ]
    expect(
      parseWorkflowCodexSessionEvidence(encode([metadata, withProfile(entries)]), expected)
    ).toMatchObject({ turnId: 'native-turn' })
  })

  it('refuses a profile that grants a write, even with a read-only sandbox policy', () => {
    for (const entries of [[{ path: { type: 'path', path: '/repo' }, access: 'write' }], 'all']) {
      expect(() =>
        parseWorkflowCodexSessionEvidence(encode([metadata, withProfile(entries)]), expected)
      ).toThrow()
    }
  })
})

describe('Codex workflow CLI version floor', () => {
  it('accepts a newer CLI and reports the rollout version', () => {
    const newer = { ...metadata, payload: { ...metadata.payload, cli_version: '0.160.2' } }
    expect(parseWorkflowCodexSessionEvidence(encode([newer, context]), expected)).toEqual({
      ...expected,
      cliVersion: '0.160.2',
      turnId: 'native-turn'
    })
  })
})

describe('Codex streamed workflow command', () => {
  const base = { model: 'gpt-5.6-sol', effort: 'high', instructionsPath: '/a/instructions.md' }

  it('keeps the legacy frozen argv byte for byte for replayed runs', () => {
    expect(buildWorkflowCodexArgs({ ...base, schemaPath: '/a/schema.json' }).join(' ')).toBe(
      'exec --ignore-user-config --skip-git-repo-check -s read-only --model gpt-5.6-sol ' +
        '--disable apps --disable plugins --disable remote_plugin --disable hooks ' +
        '--disable multi_agent --disable browser_use --disable computer_use ' +
        '--disable image_generation --disable view_image --disable shell_tool ' +
        '--disable unified_exec --disable shell_snapshot --disable goals --disable sleep_tool ' +
        '--disable skill_search --disable memories -c agents.enabled=false ' +
        '-c skills.include_instructions=false -c project_doc_max_bytes=0 ' +
        '-c web_search="disabled" -c model_reasoning_effort="high" ' +
        '-c model_instructions_file="/a/instructions.md" --output-schema /a/schema.json --json -'
    )
  })

  it('reads the workspace through a read-only profile that hides the home folder', () => {
    const args = buildWorkflowCodexStreamArgs({
      ...base,
      schemaPath: '/a/schema.json',
      workspaceRoot: '/home/sal/repo',
      hiddenPaths: ['/home/sal', '/home/sal/.ssh']
    })
    expect(args.slice(0, 5)).toEqual([
      'exec',
      '--ignore-user-config',
      '--skip-git-repo-check',
      '-C',
      '/home/sal/repo'
    ])
    // The profile replaces -s (Codex refuses both); it extends read-only.
    expect(args).not.toContain('-s')
    const config = args.filter((_, index) => args[index - 1] === '-c')
    expect(config).toEqual(
      expect.arrayContaining([
        'allow_login_shell=false',
        `default_permissions="${WORKFLOW_CODEX_PERMISSION_PROFILE}"`,
        `permissions.${WORKFLOW_CODEX_PERMISSION_PROFILE}.extends=":read-only"`,
        `permissions.${WORKFLOW_CODEX_PERMISSION_PROFILE}.filesystem=` +
          '{"/home/sal"="deny","/home/sal/.ssh"="deny","/home/sal/repo"="read"}'
      ])
    )
    expect(args).not.toContain('shell_tool')
    expect(args).not.toContain('unified_exec')
    for (const feature of ['apps', 'plugins', 'hooks', 'multi_agent', 'memories']) {
      expect(args[args.indexOf(feature) - 1]).toBe('--disable')
    }
    expect(args).toContain('model_reasoning_summary="concise"')
    expect(args).toContain('model_instructions_file="/a/instructions.md"')
    expect(args[args.indexOf('--output-schema') + 1]).toBe('/a/schema.json')
    expect(args.slice(-2)).toEqual(['--json', '-'])
  })

  it('keeps the workspace readable when it is the hidden folder itself', () => {
    const args = buildWorkflowCodexStreamArgs({
      ...base,
      workspaceRoot: '/home/sal',
      hiddenPaths: ['/home/sal/.config', '/home/sal']
    })
    expect(args).toContain(
      `permissions.${WORKFLOW_CODEX_PERMISSION_PROFILE}.filesystem=` +
        '{"/home/sal/.config"="deny","/home/sal"="read"}'
    )
    expect(() =>
      buildWorkflowCodexStreamArgs({ ...base, workspaceRoot: '/repo', hiddenPaths: ['relative'] })
    ).toThrow()
  })

  it('answers in text without an output schema and keeps shell disabled when frozen', () => {
    const args = buildWorkflowCodexStreamArgs(base)
    expect(args.slice(3, 5)).toEqual(['-s', 'read-only'])
    expect(args.some((arg) => arg.startsWith('default_permissions'))).toBe(false)
    expect(args).not.toContain('--output-schema')
    expect(args).not.toContain('-C')
    expect(args[args.indexOf('shell_tool') - 1]).toBe('--disable')
    expect(args[args.indexOf('unified_exec') - 1]).toBe('--disable')
  })

  it('refuses blank resolved inputs', () => {
    expect(() => buildWorkflowCodexStreamArgs({ ...base, model: ' ' })).toThrow()
    expect(() => buildWorkflowCodexStreamArgs({ ...base, workspaceRoot: '' })).toThrow()
  })
})
