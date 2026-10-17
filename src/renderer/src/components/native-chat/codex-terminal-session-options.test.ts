import { describe, expect, it } from 'vitest'
import { readCodexSessionOptionsFromTerminalScreen as read } from './codex-terminal-session-options'
describe('Codex runtime model and effort reporting', () => {
  it('reads the actual launch frame', () => {
    expect(
      read(
        '╭────╮\n│ >_ OpenAI Codex (v0.154.0) │\n│ model: gpt-6-astra xhigh /model to change │\n╰────╯'
      )
    ).toEqual({ model: 'gpt-6-astra', effort: 'xhigh' })
  })
  it('prefers the current runtime footer over an old launch frame', () => {
    expect(
      read(
        '│ >_ OpenAI Codex (v0.154.0) │\n│ model: gpt-6-astra xhigh │\ngpt-5.6-sol high · ~/Work/test · My work'
      )
    ).toEqual({ model: 'gpt-5.6-sol', effort: 'high' })
  })
  it('reads the max and ultra footers', () => {
    expect(read('gpt-5.6-luna max · ~/Work')).toEqual({ model: 'gpt-5.6-luna', effort: 'max' })
    expect(read('gpt-5.6-sol ultra · /srv/work')).toEqual({ model: 'gpt-5.6-sol', effort: 'ultra' })
  })
  it('reports the model without a concrete effort when Codex reports default', () => {
    expect(
      read(
        '│ >_ OpenAI Codex (v0.154.0) │\n│ model: gpt-6-astra /model to change │\n› Ask Codex to do anything\n\n  \x1b[33mgpt-6-astra default\x1b[0m · /private/tmp/repo · Resumed work'
      )
    ).toEqual({ model: 'gpt-6-astra', effort: null })
    expect(
      read(
        '│ >_ OpenAI Codex (v0.154.0) │\n│ model: gpt-6-astra ultra │\ngpt-6-astra default · ~/Work'
      )
    ).toEqual({ model: 'gpt-6-astra', effort: null })
  })
  it('keeps default-effort model reports subject to actual frame and catalog checks', () => {
    expect(read('The model is gpt-6-astra default.')).toBeNull()
    expect(read('gpt-6-astra mystery · ~/Work')).toBeNull()
    expect(
      read('gpt-6-astra default · ~/Work', [{ id: 'other', label: 'Other', options: [] }])
    ).toBeNull()
  })
  it('rejects a footer whose model is not in the supplied list', () => {
    expect(
      read('gpt-5.5 high · ~/Work', [{ id: 'gpt-5.2-codex', label: 'GPT-5.2 Codex', options: [] }])
    ).toBeNull()
    expect(
      read('gpt-5.5 high · ~/Work', [{ id: 'gpt-5.5', label: 'GPT-5.5', options: [] }])
    ).toEqual({ model: 'gpt-5.5', effort: 'high' })
  })
  it('does not infer runtime settings from prose or unavailable models', () => {
    expect(read('The model is gpt-6-astra xhigh.')).toBeNull()
    expect(
      read('gpt-6-astra xhigh · ~/Work', [{ id: 'other', label: 'Other', options: [] }])
    ).toBeNull()
  })
})
