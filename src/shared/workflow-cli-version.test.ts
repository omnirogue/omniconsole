import { describe, expect, it } from 'vitest'
import {
  parseWorkflowCliVersion,
  workflowCliVersionAtLeast,
  WORKFLOW_CLI_MINIMUM_VERSIONS
} from './workflow-cli-version'

describe('workflow CLI minimum versions', () => {
  it.each([
    ['2.1.278 (Claude Code)', '2.1.278'],
    ['codex-cli 0.155.1', '0.155.1'],
    ['grok 1.0.34 (3736acbc8658) [stable]', '1.0.34'],
    ['0.59.0\n', '0.59.0'],
    ['gemini 0.60.0-preview.2', '0.60.0']
  ])('reads the version from %j', (output, version) => {
    expect(parseWorkflowCliVersion(output)).toBe(version)
  })

  it('finds no version in unrelated output', () => {
    expect(parseWorkflowCliVersion('command not found')).toBeUndefined()
  })

  it('compares numerically rather than as text', () => {
    expect(workflowCliVersionAtLeast('grok 1.0.34 (x) [stable]', '1.0.34')).toBe(true)
    expect(workflowCliVersionAtLeast('1.0.100', '1.0.34')).toBe(true)
    expect(workflowCliVersionAtLeast('2.0.0', '1.9.99')).toBe(true)
    expect(workflowCliVersionAtLeast('1.0.30', '1.0.34')).toBe(false)
    expect(workflowCliVersionAtLeast('2.1.236 (Claude Code)', '2.1.278')).toBe(false)
    expect(workflowCliVersionAtLeast('0.155.0', '0.155.1')).toBe(false)
    expect(workflowCliVersionAtLeast('changed', '0.155.1')).toBe(false)
  })

  it('accepts the versions measured on 2026-09-21 and anything newer', () => {
    expect(WORKFLOW_CLI_MINIMUM_VERSIONS).toEqual({
      claude: '2.1.278',
      codex: '0.155.1',
      grok: '1.0.34',
      gemini: '0.59.0'
    })
    expect(workflowCliVersionAtLeast('grok 1.0.34 (3736acbc8658) [stable]', '1.0.34')).toBe(true)
    expect(workflowCliVersionAtLeast('grok 1.0.30 (04b7ffed98c6) [stable]', '1.0.34')).toBe(false)
  })
})
