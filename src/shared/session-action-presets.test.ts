import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SESSION_ACTION_TEMPLATES,
  SESSION_ACTION_PRESET_IDS,
  SESSION_ACTION_VARIABLES,
  normalizeSessionActionPresetSettings,
  normalizeSessionActionPresetsByWorkspace,
  renderSessionActionTemplate,
  resolveSessionActionPreset
} from './session-action-presets'

describe('session action presets', () => {
  it('ships a folder-safe template for every preset that names no repository tooling', () => {
    for (const id of SESSION_ACTION_PRESET_IDS) {
      const template = DEFAULT_SESSION_ACTION_TEMPLATES[id]
      expect(template).toContain('{{objective}}')
      expect(template).toContain('{{outputDir}}')
      expect(template).toContain('{{workspacePath}}')
      expect(template).not.toMatch(/git |worktree|pull request|npm test|pytest/i)
    }
    expect(DEFAULT_SESSION_ACTION_TEMPLATES.verify).toMatch(/check command|checklist/)
  })

  it('renders known variables, keeps unknown placeholders visible and marks empties', () => {
    expect(
      renderSessionActionTemplate('Do {{objective}} from {{input}} into {{outputDir}} {{nope}}', {
        objective: 'cut the intro',
        outputDir: '/w/.omni/runs/c/s'
      })
    ).toBe('Do cut the intro from (none) into /w/.omni/runs/c/s {{nope}}')
    expect(SESSION_ACTION_VARIABLES).toEqual([
      'objective',
      'input',
      'inputFiles',
      'outputDir',
      'workspacePath'
    ])
  })

  it('normalizes recipes and drops unknown presets, empty templates and unknown agents', () => {
    expect(
      normalizeSessionActionPresetSettings({
        improve: {
          template: 'Improve {{objective}}',
          actor: { agent: 'claude', model: 'opus', effort: 'max' }
        },
        review: { template: '   ', actor: { agent: 'nope' } },
        bogus: { template: 'x' },
        plan: { actor: { accountChoiceId: 'profile:p1' } }
      })
    ).toEqual({
      improve: {
        template: 'Improve {{objective}}',
        actor: { agent: 'claude', model: 'opus', effort: 'max' }
      },
      plan: { actor: { accountChoiceId: 'profile:p1' } }
    })
    expect(
      normalizeSessionActionPresetsByWorkspace({
        '/w': { improve: { template: 'Workspace improve' } },
        '': { improve: { template: 'no key' } },
        '/x': { improve: {} }
      })
    ).toEqual({ '/w': { improve: { template: 'Workspace improve' } } })
  })

  it('resolves workspace over global over default', () => {
    const settings = {
      sessionActionPresets: {
        improve: { template: 'Global improve', actor: { agent: 'codex' as const } }
      },
      sessionActionPresetsByWorkspace: {
        '/w': { improve: { template: 'Workspace improve' } }
      }
    }
    // Why: a workspace override of the template alone keeps the global actor; the two
    // halves fall back independently so an override never silently drops the actor.
    expect(resolveSessionActionPreset(settings, '/w', 'improve')).toEqual({
      id: 'improve',
      template: 'Workspace improve',
      actor: { agent: 'codex' },
      source: 'workspace'
    })
    expect(resolveSessionActionPreset(settings, '/other', 'improve')).toMatchObject({
      template: 'Global improve',
      actor: { agent: 'codex' },
      source: 'global'
    })
    expect(resolveSessionActionPreset(settings, '/other', 'plan')).toMatchObject({
      template: DEFAULT_SESSION_ACTION_TEMPLATES.plan,
      source: 'default'
    })
  })
})
