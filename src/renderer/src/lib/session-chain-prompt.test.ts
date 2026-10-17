import { describe, expect, it } from 'vitest'
import { DEFAULT_SESSION_ACTION_TEMPLATES } from '../../../shared/session-action-presets'
import {
  boundSessionChainInput,
  buildSessionChainStepPrompt,
  SESSION_CHAIN_INPUT_CHAR_LIMIT
} from './session-chain-prompt'

const chain = { id: 'chn_1', workspacePath: '/Users/me/Webinar' }

describe('buildSessionChainStepPrompt', () => {
  it('renders a preset with the objective, previous output, previous files and the output folder', () => {
    const { prompt, outputDir } = buildSessionChainStepPrompt({
      settings: {},
      chain,
      step: { id: 'step_2', prompt: 'tighten the intro', presetId: 'improve' },
      previousOutput: 'I drafted intro-v1.md',
      previousFiles: ['/Users/me/Webinar/.omni/runs/chn_1/step_1/intro-v1.md']
    })
    expect(outputDir).toBe('/Users/me/Webinar/.omni/runs/chn_1/step_2')
    expect(prompt).toContain('tighten the intro')
    expect(prompt).toContain('I drafted intro-v1.md')
    expect(prompt).toContain('/Users/me/Webinar/.omni/runs/chn_1/step_1/intro-v1.md')
    expect(prompt).toContain('/Users/me/Webinar/.omni/runs/chn_1/step_2/manifest.md')
    expect(prompt).not.toContain('{{')
  })

  it('prefers a workspace override of the template', () => {
    const { prompt } = buildSessionChainStepPrompt({
      settings: {
        sessionActionPresetsByWorkspace: {
          '/Users/me/Webinar': {
            improve: { template: 'Workspace: {{objective}} -> {{outputDir}}' }
          }
        }
      },
      chain,
      step: { id: 'step_1', prompt: 'polish', presetId: 'improve' },
      previousOutput: '',
      previousFiles: []
    })
    expect(prompt).toContain('Workspace: polish -> /Users/me/Webinar/.omni/runs/chn_1/step_1')
    expect(prompt).toContain(
      'First answer briefly how you will attain the chosen outcome, then act'
    )
    expect(prompt).not.toBe(DEFAULT_SESSION_ACTION_TEMPLATES.improve)
  })

  it('keeps a plain instruction as the prompt and appends the mechanical handoff', () => {
    const { prompt } = buildSessionChainStepPrompt({
      settings: null,
      chain,
      step: { id: 'step_3', prompt: 'Export the final cut as mp4.' },
      previousOutput: 'done',
      previousFiles: ['/Users/me/Webinar/.omni/runs/chn_1/step_2/cut.prproj']
    })
    expect(prompt).toContain('Export the final cut as mp4.')
    expect(prompt).toContain(
      'First answer briefly how you will attain the chosen outcome, then act'
    )
    expect(prompt).toContain(
      'Files from the previous step:\n/Users/me/Webinar/.omni/runs/chn_1/step_2/cut.prproj'
    )
    expect(prompt).toContain('/Users/me/Webinar/.omni/runs/chn_1/step_3')
  })

  it('bounds the inlined previous output', () => {
    const long = 'x'.repeat(SESSION_CHAIN_INPUT_CHAR_LIMIT + 50)
    expect(boundSessionChainInput(long)).toHaveLength(SESSION_CHAIN_INPUT_CHAR_LIMIT + 1)
    expect(boundSessionChainInput(long).startsWith('…')).toBe(true)
    expect(boundSessionChainInput('short')).toBe('short')
  })
})
