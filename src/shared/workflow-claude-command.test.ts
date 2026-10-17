import { describe, expect, it } from 'vitest'
import { buildWorkflowClaudeArgs, buildWorkflowClaudeStreamArgs } from './workflow-claude-command'
import {
  workflowAgentInstructions,
  WORKFLOW_FROZEN_EVIDENCE_INSTRUCTIONS
} from './workflow-agent-instructions'

const attemptId = '00000000-0000-4000-8000-000000000001'
const schema = { type: 'object', properties: { markdown: { type: 'string' } } }

describe('workflow Claude command', () => {
  it('does not inherit Plan mode from the commit-message recipe', () => {
    const args = buildWorkflowClaudeArgs({
      model: 'sonnet',
      attemptId,
      schema: { type: 'object', properties: { markdown: { type: 'string' } } }
    })
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk')
    expect(args[args.indexOf('--tools') + 1]).toBe('')
    expect(args[args.indexOf('--output-format') + 1]).toBe('json')
    expect(args).not.toContain('plan')
  })

  it('keeps the legacy frozen argv byte for byte for replayed runs', () => {
    expect(
      buildWorkflowClaudeArgs({ model: 'claude-sonnet-5', effort: 'high', attemptId, schema })
    ).toEqual([
      '-p',
      '--output-format',
      'json',
      '--model',
      'claude-sonnet-5',
      '--permission-mode',
      'dontAsk',
      '--effort',
      'high',
      '--json-schema',
      JSON.stringify(schema),
      '--tools',
      '',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--setting-sources',
      '',
      '--disable-slash-commands',
      '--no-session-persistence',
      '--session-id',
      attemptId,
      '--system-prompt',
      WORKFLOW_FROZEN_EVIDENCE_INSTRUCTIONS
    ])
  })

  it('streams with read-only file tools in the workspace', () => {
    const args = buildWorkflowClaudeStreamArgs({
      model: 'claude-opus-5',
      effort: 'high',
      attemptId,
      access: 'workspace-read',
      schema
    })
    expect(args.slice(0, 5)).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages'
    ])
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob')
    expect(args).toContain('--restricted')
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk')
    expect(args[args.indexOf('--json-schema') + 1]).toBe(JSON.stringify(schema))
    expect(args[args.indexOf('--session-id') + 1]).toBe(attemptId)
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('{"mcpServers":{}}')
    expect(args).toContain('--strict-mcp-config')
    expect(args).toContain('--no-session-persistence')
    expect(args).not.toContain('--system-prompt')
    expect(args.at(-2)).toBe('--append-system-prompt')
    expect(args.at(-1)).toBe(workflowAgentInstructions('workspace-read', 'schema'))
  })

  it('answers in text without a schema or tools when frozen', () => {
    const args = buildWorkflowClaudeStreamArgs({
      model: 'claude-opus-5',
      attemptId,
      access: 'frozen'
    })
    expect(args).not.toContain('--json-schema')
    expect(args).not.toContain('--effort')
    expect(args[args.indexOf('--tools') + 1]).toBe('')
    expect(args.at(-2)).toBe('--system-prompt')
    expect(args.at(-1)).toBe(workflowAgentInstructions('frozen', 'text'))
    expect(args.at(-1)).toContain('Markdown')
  })

  it('refuses a missing model or attempt identity', () => {
    expect(() =>
      buildWorkflowClaudeStreamArgs({ model: ' ', attemptId, access: 'frozen' })
    ).toThrow()
    expect(() =>
      buildWorkflowClaudeStreamArgs({ model: 'claude-opus-5', attemptId: '', access: 'frozen' })
    ).toThrow()
  })
})
