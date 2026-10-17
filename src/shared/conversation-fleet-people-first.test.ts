import { describe, expect, it } from 'vitest'
import { compileNextStepChain } from './next-step-compile'
import { emptyNextStepDraft } from './next-step-draft'
import {
  buildConversationFleetWorkflow,
  type ConversationFleetWorkflowInput
} from './conversation-fleet-workflow'
import {
  hasConversationFleetAgent,
  resolveConversationFleetFolderMachine
} from './conversation-fleet-machine'
import type { ConsoleConversationFleetInventory } from './console-conversation-fleet-types'

function input(): ConversationFleetWorkflowInput {
  return {
    operationId: 'people_first_123',
    companySlug: 'omni',
    context: {
      title: 'Continue this work',
      sourceSessionId: 'source',
      sourceWorkspacePath: '/source',
      transcript: 'The captured source.'
    },
    sourceSummaryFile: {
      kind: 'task_file',
      task_id: 'btk_source',
      file: {
        rel: 'summary.md',
        name: 'summary.md',
        sha256: 'a'.repeat(64),
        size_bytes: 10
      }
    },
    draft: {
      ...emptyNextStepDraft(),
      recipients: [{ kind: 'person', key: 'one', id: 'emp_one', name: 'One' }],
      after: [
        { kind: 'person', key: 'two', id: 'emp_two', name: 'Two' },
        {
          kind: 'agent',
          key: 'agent',
          actor: { agent: 'codex' },
          presetId: 'improve',
          instructions: 'Continue the captured work.',
          rounds: 1
        }
      ]
    }
  }
}

describe('fleet people-first workflows', () => {
  it('retains explicit later agents and gates them on delivery receipts with original source context', () => {
    const request = input()
    const steps = buildConversationFleetWorkflow(request).classification.steps
    expect(steps.map((step) => step.key)).toEqual(['step-1-person-1', 'step-2-person-1', 'step-3'])
    expect(steps.map((step) => step.after)).toEqual([[], ['step-1-person-1'], ['step-2-person-1']])
    expect(steps[2]!.actor_type).toBe('ai')
    expect(steps[2]!.brief).toContain('Use the original conversation below')
    expect(steps[1]!.person_handoff).toMatchObject({
      include_summary: true,
      deliverables: { kind: 'files', paths: [] },
      summary_file: request.sourceSummaryFile
    })
  })

  it('leaves the existing local compiler behavior unchanged unless the option is enabled', () => {
    const request = input()
    const compileInput = {
      draft: request.draft,
      chainId: request.operationId,
      workspacePath: '.',
      sessionLabel: 'Source',
      defaultNote: 'Next',
      now: 0,
      cardlessHandoffs: true,
      mintOperationId: () => 'operation-123',
      mintStepId: (position: number) => `step-${position}`
    }
    expect(compileNextStepChain(compileInput).steps).toHaveLength(1)
    expect(compileNextStepChain({ ...compileInput, allowAfterPeople: true }).steps).toHaveLength(3)
  })

  it('selects the actual later agent route with the same captured source pins', () => {
    const request = input()
    const inventory: ConsoleConversationFleetInventory = {
      providers: ['codex'],
      people: [],
      repositories: [],
      models_fallback: false,
      models: [
        {
          id: 'codex:chosen',
          provider: 'codex',
          model: 'chosen',
          supported_efforts: [],
          default: true,
          seat_ready: true,
          aliases: []
        }
      ],
      machines: [
        {
          host: 'mw0004',
          allowed: true,
          ready: true,
          last_beat: null,
          slots: 1,
          running: 0,
          execution_capabilities: [
            {
              provider: 'codex',
              available: true,
              resume: true,
              readonly: true,
              native_execution: true,
              pinned_task_inputs: true,
              source_snapshot: true,
              folder_workspace: true,
              models: ['chosen'],
              efforts: [],
              account_usage: {
                version: 1,
                selected_account_ref: '11111111-1111-4111-8111-111111111111',
                account_generation: '22222222-2222-4222-8222-222222222222',
                usage: {
                  provider: 'codex',
                  status: 'ok',
                  updatedAt: Date.now() - 1_000,
                  error: null,
                  session: {
                    usedPercent: 20,
                    windowMinutes: 300,
                    resetsAt: null,
                    resetDescription: null
                  },
                  weekly: null
                }
              }
            }
          ]
        }
      ]
    }
    expect(hasConversationFleetAgent(request.draft)).toBe(true)
    expect(
      resolveConversationFleetFolderMachine(request.draft, inventory, {
        sourceSummaryFile: request.sourceSummaryFile
      })
    ).toBe('mw0004')
    request.draft.after.pop()
    expect(hasConversationFleetAgent(request.draft)).toBe(false)
  })
})
