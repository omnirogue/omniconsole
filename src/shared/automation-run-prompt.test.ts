import { describe, expect, it } from 'vitest'
import { buildAutomationRunPrompt } from './automation-run-prompt'
import type { AutomationStructuredOutput } from './automation-structured-output'
import { ADVERTISING_CANDIDATE_INSTRUCTIONS } from './typesafe-advertising'

describe('buildAutomationRunPrompt', () => {
  const prompt = '  Review the latest results.\r\nPreserve my instructions.\n  '

  it.each([undefined, null])('preserves the exact prompt when disabled (%s)', (setting) => {
    expect(buildAutomationRunPrompt(prompt, setting)).toBe(prompt)
    expect(buildAutomationRunPrompt('', setting)).toBe('')
  })

  it('requests evidence and typed conclusions in the captured final response', () => {
    const result = buildAutomationRunPrompt(prompt, {
      provider: 'typesafe',
      contract: 'classification.v1'
    })

    expect(result.startsWith(`${prompt}\n\n`)).toBe(true)
    for (const value of ['PASS', 'FAIL', 'INCONCLUSIVE', 'INFO', 'WARNING', 'ERROR']) {
      expect(result).toContain(value)
    }
    expect(result).toContain('final response')
    expect(result).toContain('missing evidence or uncertainty')
    expect(result).not.toContain('omni-advertising-candidates')
  })

  it.each(['omnirogue', 'betacorp'] as const)(
    'requests canonical advertising selectors bound to %s without changing the saved settings',
    (company) => {
      const setting = Object.freeze({
        provider: 'typesafe' as const,
        contract: 'advertising.v1' as const,
        advertising: Object.freeze({ company, accountId: 'act_123456789' })
      })
      const savedSetting = JSON.stringify(setting)

      const result = buildAutomationRunPrompt(prompt, setting)

      expect(result.startsWith(`${prompt}\n\n`)).toBe(true)
      expect(result).toContain(ADVERTISING_CANDIDATE_INSTRUCTIONS)
      expect(result).toContain(`company ${company} and account act_123456789`)
      expect(result).toContain('empty candidate array')
      expect(result).not.toContain('classification.v1')
      expect(JSON.stringify(setting)).toBe(savedSetting)
    }
  )

  it.each([
    { provider: 'unknown', contract: 'classification.v1' },
    { provider: 'typesafe', contract: 'unknown' },
    { provider: 'typesafe', contract: 'advertising.v1' }
  ])('refuses unsupported or incomplete saved settings: %o', (setting) => {
    expect(() => buildAutomationRunPrompt(prompt, setting as AutomationStructuredOutput)).toThrow(
      'Invalid structured decision settings'
    )
  })

  it('preserves a saved final legacy action block requirement when adding read-only selectors', () => {
    const saved =
      'Report proposals only. End with exactly one omni-actions block and nothing after it.'
    const result = buildAutomationRunPrompt(saved, {
      provider: 'typesafe',
      contract: 'advertising.v1',
      advertising: { company: 'omnirogue', accountId: 'act_1000000000000001' }
    })
    expect(result.startsWith(`${saved}\n\n`)).toBe(true)
    expect(result).toContain('before any required final legacy omni-actions block')
    expect(result).toContain('preserve that legacy block as the last output with nothing after it')
    expect(result).toContain("Preserve the routine's existing report and action instructions")
    expect(result).not.toContain('append one fenced')
    expect(buildAutomationRunPrompt(saved)).toBe(saved)
  })
})
