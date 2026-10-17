import { describe, expect, it } from 'vitest'
import { agentTemplateDigest, type AgentTemplateSettings } from './agent-templates'
import {
  resolveSessionAgentTemplate,
  sessionAgentTemplateSchema,
  sessionAgentTemplateView
} from './session-agent-template'

const advertising: AgentTemplateSettings = {
  custom: [
    {
      id: 'advertising',
      name: 'Advertising',
      description: 'Pauses by evidence',
      instructions: '# Advertising\nPause, never scale.'
    }
  ]
}

describe('agentTemplateDigest', () => {
  it('is the first 12 hex of the sha256 of the normalized text', () => {
    // Why fixed values: they were computed with node:crypto, so the shared hash cannot drift.
    expect(agentTemplateDigest('# Advertising\nPause, never scale.')).toBe('d30fc78b9495')
    expect(agentTemplateDigest(null)).toBe('e3b0c44298fc')
  })

  it('ignores CRLF line endings and surrounding whitespace', () => {
    expect(agentTemplateDigest('\n  # Advertising\r\nPause, never scale.  \n')).toBe('d30fc78b9495')
  })
})

describe('resolveSessionAgentTemplate', () => {
  it('resolves a known id to its name and current digest', () => {
    expect(resolveSessionAgentTemplate(advertising, 'advertising')).toEqual({
      ok: true,
      template: { id: 'advertising', name: 'Advertising', digest: 'd30fc78b9495' }
    })
    expect(resolveSessionAgentTemplate(undefined, 'developer')).toEqual({
      ok: true,
      template: { id: 'developer', name: 'Developer', digest: '1f319edbed97' }
    })
  })

  it('records an explicit Default like any other template', () => {
    expect(resolveSessionAgentTemplate(advertising, 'default')).toEqual({
      ok: true,
      template: { id: 'default', name: 'Default', digest: 'e3b0c44298fc' }
    })
  })

  it('refuses an unknown id instead of falling back', () => {
    const result = resolveSessionAgentTemplate(advertising, 'advertsing')
    expect(result.ok).toBe(false)
    expect(!result.ok && result.message).toContain('Unknown agent template "advertsing"')
  })
})

describe('sessionAgentTemplateView', () => {
  const recorded = { id: 'advertising', name: 'Advertising', digest: 'd30fc78b9495' }

  it('never reads a missing record as Default', () => {
    expect(sessionAgentTemplateView(undefined, advertising)).toEqual({ state: 'unrecorded' })
    expect(
      sessionAgentTemplateView({ id: 'default', name: 'Default', digest: 'e3b0c44298fc' }, {})
    ).toEqual({ state: 'default' })
  })

  it('is current while the text is unchanged', () => {
    expect(sessionAgentTemplateView(recorded, advertising)).toEqual({
      state: 'current',
      id: 'advertising',
      name: 'Advertising'
    })
  })

  it('says changed once the instructions differ from the recorded digest', () => {
    const edited: AgentTemplateSettings = {
      custom: [{ ...advertising.custom![0]!, instructions: '# Advertising\nPause first.' }]
    }
    expect(sessionAgentTemplateView(recorded, edited).state).toBe('changed')
  })

  it('keeps the recorded name when the template was removed', () => {
    expect(sessionAgentTemplateView(recorded, {})).toEqual({
      state: 'removed',
      id: 'advertising',
      name: 'Advertising'
    })
  })
})

describe('sessionAgentTemplateSchema', () => {
  it('accepts a record and rejects a malformed digest', () => {
    expect(
      sessionAgentTemplateSchema.safeParse({ id: 'a', name: 'A', digest: 'd30fc78b9495' }).success
    ).toBe(true)
    expect(
      sessionAgentTemplateSchema.safeParse({ id: 'a', name: 'A', digest: 'nothex' }).success
    ).toBe(false)
  })
})
