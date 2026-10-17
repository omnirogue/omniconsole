import { describe, expect, it } from 'vitest'
import {
  buildConversationFleetWorkflow,
  type ConversationFleetWorkflowInput
} from './conversation-fleet-workflow'
import { emptyNextStepDraft } from './next-step-draft'

function request(presetId: 'review' | 'verify', folder: boolean): ConversationFleetWorkflowInput {
  return {
    operationId: 'report_12345678',
    companySlug: 'omni',
    ...(folder
      ? { workspace: { kind: 'folder' as const, host: 'mw0004', allocation: 'job' as const } }
      : { repo: 'Example/project' }),
    context: {
      title: 'Check the result',
      sourceSessionId: 'source',
      sourceWorkspacePath: '/source',
      transcript: 'Original captured request.'
    },
    draft: {
      ...emptyNextStepDraft(),
      recipients: [
        {
          kind: 'agent',
          key: 'first',
          agent: 'codex',
          presetId,
          instructions: 'Check this.',
          rounds: 1
        }
      ],
      after: [{ kind: 'person', key: 'person', id: 'emp_one', name: 'One' }]
    }
  }
}

describe('retained reports for person deliveries', () => {
  it.each(['review', 'verify'] as const)(
    'retains exact %s response and selected manifest for repository delivery',
    (preset) => {
      const stage = buildConversationFleetWorkflow(request(preset, false)).classification.steps[0]!
      expect(stage.action).toBe('review')
      expect(stage.handoff_report).toEqual({
        path: 'handoff-result.json',
        format: 'json',
        max_bytes: 50_331_648,
        files: [],
        manifests: ['.omni/runs/report_12345678/step-1/manifest.md'],
        outputs: [
          { path: `.omni/runs/report_12345678/step-1/${preset}.md`, source: 'response' },
          { path: '.omni/runs/report_12345678/step-1/manifest.md', source: 'manifest' }
        ]
      })
      expect(stage.output_artifacts).toBeUndefined()
    }
  )

  it.each(['review', 'verify'] as const)('uses the folder artifact boundary for %s', (preset) => {
    const stage = buildConversationFleetWorkflow(request(preset, true)).classification.steps[0]!
    expect(stage.output_artifacts).toEqual([
      { path: `.omni/runs/report_12345678/step-1/${preset}.md`, source: 'response' },
      { path: '.omni/runs/report_12345678/step-1/manifest.md', source: 'manifest' }
    ])
    expect(stage.handoff_report).toBeUndefined()
  })

  it('does not invent a requested file from a custom recipe response', () => {
    const input = request('review', false)
    input.settings = {
      sessionActionPresetsByWorkspace: {
        '/source': {
          review: {
            template: 'Review these images and save the requested comparison.png.'
          }
        }
      }
    }
    const stage = buildConversationFleetWorkflow(input).classification.steps[0]!
    expect(stage.brief).toContain('comparison.png')
    expect(stage.handoff_report?.outputs).toEqual([
      { path: '.omni/runs/report_12345678/step-1/manifest.md', source: 'manifest' }
    ])
  })

  it('adds no person report contract when no people receive the stage output', () => {
    const input = request('review', false)
    input.draft.after = []
    const stage = buildConversationFleetWorkflow(input).classification.steps[0]!
    expect(stage.handoff_report).toBeUndefined()
    expect(stage.output_artifacts).toBeUndefined()
  })
})
