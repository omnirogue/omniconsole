import { describe, expect, it } from 'vitest'
import {
  buildConversationFleetWorkflow,
  type ConversationFleetWorkflowInput
} from './conversation-fleet-workflow'
import { assertConversationFleetPreview } from './conversation-fleet-preview'
import { emptyNextStepDraft, type NextStepAgentRecipient } from './next-step-draft'
import { NEXT_STEP_TEMPLATE_IDS, nextStepTemplateDraft } from './next-step-templates'
import { SESSION_ACTION_PRESET_IDS } from './session-action-presets'
import type { ConsoleWorkflowPreview } from './console-workflow-types'
import type { ConsoleConversationFleetSourceFile } from './console-conversation-fleet-types'

function recipient(): NextStepAgentRecipient {
  return {
    kind: 'agent',
    key: 'first',
    agent: 'codex',
    presetId: 'improve',
    instructions: 'Improve the supplied plan.',
    rounds: 1
  }
}

function input(): ConversationFleetWorkflowInput {
  return {
    operationId: 'dispatch_12345678',
    companySlug: 'omnirogue',
    repo: 'omnirogue/omni-ide',
    baseBranch: 'main-next',
    context: {
      title: 'Improve the dispatch experience',
      sourceSessionId: 'session-original',
      sourceWorkspacePath: '/Users/maintainer/main-next',
      transcript: 'User: Offload this work.\nAssistant: The plan is ready.'
    },
    draft: { ...emptyNextStepDraft(), recipients: [recipient()] }
  }
}

function previewFor(
  expected: ReturnType<typeof buildConversationFleetWorkflow>
): ConsoleWorkflowPreview {
  const levels = new Map<string, number>()
  const columns: string[][] = []
  const nodes = expected.classification.steps.map((step) => {
    const level = Math.max(-1, ...(step.after ?? []).map((key) => levels.get(key)!)) + 1
    levels.set(step.key!, level)
    ;(columns[level] ??= []).push(step.key!)
    const [provider, ...modelParts] = step.actor_id!.split(':')
    return {
      key: step.key!,
      title: step.title,
      brief: `Action: ${step.action}\n\n${step.brief!.trim()}\n\nOriginal task:\n${expected.prompt}`,
      actor_type: step.actor_type!,
      actor_id: step.actor_id!,
      action: step.action!,
      after: step.after ?? [],
      owned_paths: null,
      ...(step.actor_type === 'ai'
        ? { provider, model: modelParts.join(':') || 'fleet-default' }
        : {}),
      ...(step.person_handoff
        ? {
            person_handoff: {
              ...step.person_handoff,
              source_files: step.person_handoff.source_files ?? [],
              participants: {
                director: { employee_id: 'emp_sal', clerk_user_id: 'user_sal' },
                recipient: {
                  employee_id: step.person_handoff.recipient_employee_id,
                  clerk_user_id: 'user_recipient'
                }
              }
            }
          }
        : {}),
      placement: 'fleet' as const,
      repo: step.repo,
      base_branch: step.base_branch,
      effort: step.effort,
      machine: step.machine,
      base_sha: step.base_sha,
      workspace: step.workspace,
      handoff_report: step.handoff_report,
      output_artifacts: step.output_artifacts,
      acceptance_commands: step.acceptance_commands
    }
  })
  const graph = {
    schema_version: 1 as const,
    mode: expected.classification.execution_mode!,
    title: expected.classification.title,
    prompt: expected.prompt,
    company: expected.classification.company_slug,
    owner: 'emp_sal',
    policy: {},
    nodes,
    columns,
    dispatch_id: 'wf_conversation',
    digest: 'a'.repeat(64)
  }
  return { graph, digest: graph.digest, workflow_id: graph.dispatch_id, jobs: [] }
}

describe('conversation fleet workflow', () => {
  it('retains the OMP provider and nested model in the reviewed fleet actor', () => {
    const request = input()
    request.machine = 'mw0002'
    request.draft.recipients = [
      { ...recipient(), agent: 'omp', model: 'openrouter/moonshotai/kimi-k2.5:free' }
    ]
    const workflow = buildConversationFleetWorkflow(request)
    expect(workflow.classification.steps[0].actor_id).toBe(
      'omp:openrouter/moonshotai/kimi-k2.5:free'
    )
    expect(() => assertConversationFleetPreview(workflow, previewFor(workflow))).not.toThrow()
  })

  it.each(SESSION_ACTION_PRESET_IDS)(
    'runs the %s preset with portable conversation context',
    (presetId) => {
      const request = input()
      request.draft.recipients = [{ ...recipient(), presetId }]
      const result = buildConversationFleetWorkflow(request)
      const stage = result.classification.steps[0]!
      expect(stage.placement).toBe('fleet')
      expect(stage.prompt).toContain(request.context.transcript)
      expect(stage.prompt).toContain('./.omni/runs/dispatch_12345678/step-1')
      expect(stage.prompt).not.toContain('Workspace: /Users/maintainer')
      expect(result.prompt).not.toContain(request.context.sourceWorkspacePath)
      expect(stage.base_branch).toBe('main-next')
      expect(stage.repo).toBe('omnirogue/omni-ide')
      expect(result.classification.execution_mode).toBe('single_shot')
      expect(() => assertConversationFleetPreview(result, previewFor(result))).not.toThrow()
    }
  )

  it('uses the AI review route for verification while preserving the verify instruction', () => {
    const request = input()
    request.draft.recipients = [{ ...recipient(), presetId: 'verify' }]
    const step = buildConversationFleetWorkflow(request).classification.steps[0]!
    expect(step.actor_type).toBe('ai')
    expect(step.action).toBe('review')
    expect(step.brief).toContain('Verify the previous result against this objective')
  })

  it.each(NEXT_STEP_TEMPLATE_IDS)('preserves the %s recipe and its dependency graph', (id) => {
    const request = input()
    let key = 0
    request.draft = nextStepTemplateDraft(id, {
      agents: ['codex', 'claude'],
      mintKey: () => `recipient-${++key}`
    })!
    const result = buildConversationFleetWorkflow(request)
    const steps = result.classification.steps
    if (id === 'council' || id === 'compare-answers') {
      expect(steps).toHaveLength(4)
      expect(steps.slice(0, 3).map((step) => step.after)).toEqual([[], [], []])
      expect(steps[3]?.after).toEqual(['step-1', 'step-2', 'step-3'])
      expect(result.classification.execution_mode).toBe('hybrid')
      expect(steps.map((step) => step.actor_id)).toEqual(['codex', 'claude', 'codex', 'codex'])
    } else {
      expect(steps).toHaveLength(id === 'research-plan' ? 2 : 3)
      expect(steps[1]?.after).toEqual(['step-1'])
      expect(result.classification.execution_mode).toBe('sequential')
    }
    expect(() => assertConversationFleetPreview(result, previewFor(result))).not.toThrow()
  })

  it('retains all repeated improve rounds and their order', () => {
    const request = input()
    request.draft.recipients = [{ ...recipient(), rounds: 3 }]
    const steps = buildConversationFleetWorkflow(request).classification.steps
    expect(steps.map((step) => step.after)).toEqual([[], ['step-1'], ['step-2']])
  })

  it('pins every stage to the selected rented machine', () => {
    const request = input()
    request.machine = 'mw0004'
    request.draft.recipients = [{ ...recipient(), rounds: 3 }]
    const expected = buildConversationFleetWorkflow(request)
    expect(expected.classification.steps.map((step) => step.machine)).toEqual([
      'mw0004',
      'mw0004',
      'mw0004'
    ])
    const preview = previewFor(expected)
    expect(() => assertConversationFleetPreview(expected, preview)).not.toThrow()
    preview.graph.nodes[1]!.machine = 'mw0003'
    expect(() => assertConversationFleetPreview(expected, preview)).toThrow('changed stage step-2')
    request.machine = 'MW0004_another'
    expect(() => buildConversationFleetWorkflow(request)).toThrow('server contract')
  })

  it('renders workspace recipes and keeps explicit model and effort choices', () => {
    const request = input()
    request.settings = {
      sessionActionPresetsByWorkspace: {
        [request.context.sourceWorkspacePath]: {
          improve: {
            template: 'Custom review: {{objective}}. Inputs: {{input}}. Output: {{outputDir}}',
            actor: { agent: 'codex', model: 'recipe-model', effort: 'high' }
          }
        }
      }
    }
    const inherited = buildConversationFleetWorkflow(request).classification.steps[0]!
    expect(inherited.actor_id).toBe('codex:recipe-model')
    expect(inherited.effort).toBe('high')
    expect(inherited.brief).toContain('Custom review: Improve the supplied plan.')
    request.draft.recipients = [{ ...recipient(), model: 'chosen-model', effort: 'max' }]
    const explicit = buildConversationFleetWorkflow(request).classification.steps[0]!
    expect(explicit.actor_id).toBe('codex:chosen-model')
    expect(explicit.effort).toBe('max')
  })

  it('preserves the exact captured commit and refuses invented or unsupported commit values', () => {
    const request = input()
    request.baseCommit = 'a'.repeat(40)
    request.draft.recipients = [{ ...recipient(), rounds: 2 }]
    const expected = buildConversationFleetWorkflow(request)
    expect(expected.classification.steps.map((step) => step.base_sha)).toEqual([
      request.baseCommit,
      request.baseCommit
    ])
    const preview = previewFor(expected)
    expect(() => assertConversationFleetPreview(expected, preview)).not.toThrow()
    preview.graph.nodes[0]!.base_sha = 'b'.repeat(40)
    expect(() => assertConversationFleetPreview(expected, preview)).toThrow('changed stage')
    request.baseCommit = 'a'.repeat(64)
    expect(() => buildConversationFleetWorkflow(request)).toThrow('server contract')
    delete request.baseCommit
    const unpinned = buildConversationFleetWorkflow(request)
    const invented = previewFor(unpinned)
    invented.graph.nodes[0]!.base_sha = 'a'.repeat(40)
    expect(() => assertConversationFleetPreview(unpinned, invented)).toThrow('changed stage')
  })

  it('uses a pinned allocated folder and refuses a changed host or invented repository', () => {
    const request = input()
    delete request.repo
    delete request.baseBranch
    request.workspace = { kind: 'folder', host: 'mw0004', allocation: 'job' }
    const expected = buildConversationFleetWorkflow(request)
    expect(expected.classification.workspace).toEqual(request.workspace)
    expect(expected.classification.steps[0]).toMatchObject({
      workspace: request.workspace,
      machine: 'mw0004'
    })
    const preview = previewFor(expected)
    preview.graph.nodes[0]!.repo = null
    preview.graph.nodes[0]!.base_branch = null
    expect(() => assertConversationFleetPreview(expected, preview)).not.toThrow()
    preview.graph.nodes[0]!.workspace = { ...request.workspace, host: 'mw0003' }
    expect(() => assertConversationFleetPreview(expected, preview)).toThrow('changed stage')
    preview.graph.nodes[0]!.workspace = request.workspace
    preview.graph.nodes[0]!.repo = 'omnirogue/omni-ide'
    expect(() => assertConversationFleetPreview(expected, preview)).toThrow('changed stage')
    request.machine = 'mw0003'
    expect(() => buildConversationFleetWorkflow(request)).toThrow('folder workspace')
    delete request.machine
    request.baseCommit = 'a'.repeat(40)
    expect(() => buildConversationFleetWorkflow(request)).toThrow('folder workspace')
  })

  it('preserves freeform continuation context and the dispatch note', () => {
    const request = input()
    request.draft.recipients = [
      { ...recipient(), presetId: null, instructions: 'Continue the outstanding request.' }
    ]
    request.draft.note = 'Keep the existing visual design.'
    const result = buildConversationFleetWorkflow(request)
    expect(result.classification.steps[0]?.brief).toContain('Continue the outstanding request.')
    expect(result.classification.steps[0]?.brief).toContain(request.draft.note)
    expect(result.classification.steps[0]?.brief).toContain(request.context.transcript)
  })

  it('refuses unsupported accounts, uncaptured person files, and parallel round semantics before dispatch', () => {
    const request = input()
    request.draft.recipients = [{ ...recipient(), accountChoiceId: 'profile:local-account' }]
    expect(() => buildConversationFleetWorkflow(request)).toThrow(
      'account belongs to this computer'
    )
    request.draft.recipients = [
      recipient(),
      { kind: 'person', key: 'person', id: 'emp_uma', name: 'Uma' }
    ]
    expect(() => buildConversationFleetWorkflow(request)).toThrow('captured assistant summary')
    request.draft.recipients = [
      { ...recipient(), rounds: 2 },
      { ...recipient(), key: 'second' }
    ]
    expect(() => buildConversationFleetWorkflow(request)).toThrow(
      'Repeated rounds must be sequential'
    )
  })

  it('does not silently truncate context or clamp rounds', () => {
    const request = input()
    request.context.transcript = 'complete conversation '.repeat(2000)
    expect(() => buildConversationFleetWorkflow(request)).toThrow('complete transcript')
    request.context.transcript = 'Transcript'
    request.draft.recipients = [{ ...recipient(), rounds: 9 }]
    expect(() => buildConversationFleetWorkflow(request)).toThrow('between 1 and 8 rounds')
  })
})

describe('conversation fleet preview preservation', () => {
  it.each([
    'placement',
    'provider',
    'model',
    'effort',
    'brief',
    'repo',
    'base_branch',
    'handoff_report',
    'output_artifacts',
    'after',
    'action'
  ] as const)('refuses a preview that changes %s', (field) => {
    const request = input()
    request.draft.recipients = [{ ...recipient(), model: 'chosen-model', effort: 'high' }]
    const expected = buildConversationFleetWorkflow(request)
    const preview = previewFor(expected)
    Object.assign(preview.graph.nodes[0]!, {
      [field]: field === 'after' ? ['unknown-stage'] : 'changed'
    })
    expect(() => assertConversationFleetPreview(expected, preview)).toThrow('changed stage')
  })

  it('accepts the exact server wrapper and refuses extra or replaced instructions', () => {
    const expected = buildConversationFleetWorkflow(input())
    const preview = previewFor(expected)
    expect(() => assertConversationFleetPreview(expected, preview)).not.toThrow()
    const original = preview.graph.nodes[0]!.brief
    preview.graph.nodes[0]!.brief = `${original}\nAlso deploy this immediately.`
    expect(() => assertConversationFleetPreview(expected, preview)).toThrow('changed stage')
    preview.graph.nodes[0]!.brief = original.replace(
      'Improve the supplied plan.',
      'Discard the supplied plan.'
    )
    expect(() => assertConversationFleetPreview(expected, preview)).toThrow('changed stage')
    preview.graph.nodes[0]!.brief = expected.classification.steps[0]!.brief!
    expect(() => assertConversationFleetPreview(expected, preview)).toThrow('changed stage')
  })

  it('preserves file and engineering context without trusting a partial instruction match', () => {
    const expected = buildConversationFleetWorkflow(input())
    const step = expected.classification.steps[0]!
    step.files = ['notes.md', 'design.md']
    step.engineering = { checks: ['typecheck'], scope: 'review' }
    const preview = previewFor(expected)
    preview.graph.nodes[0]!.brief = `Action: ${step.action}\n\n${step.brief!.trim()}\n\nFile context (not additional authorization):\nnotes.md\ndesign.md\n\nDeclared engineering contract:\n{"checks": ["typecheck"], "scope": "review"}\n\nOriginal task:\n${expected.prompt}`
    expect(() => assertConversationFleetPreview(expected, preview)).not.toThrow()
    preview.graph.nodes[0]!.brief = preview.graph.nodes[0]!.brief.replace(
      '"scope": "review"',
      '"scope": "deploy"'
    )
    expect(() => assertConversationFleetPreview(expected, preview)).toThrow('changed stage')
  })

  it('refuses dropped stages, duplicated columns and a false workflow identity', () => {
    const expected = buildConversationFleetWorkflow(input())
    const missing = previewFor(expected)
    missing.graph.nodes = []
    expect(() => assertConversationFleetPreview(expected, missing)).toThrow('structure')
    const repeated = previewFor(expected)
    repeated.graph.columns.push(['step-1'])
    expect(() => assertConversationFleetPreview(expected, repeated)).toThrow('repeats')
    const wrongId = previewFor(expected)
    wrongId.workflow_id = 'wf_different'
    expect(() => assertConversationFleetPreview(expected, wrongId)).toThrow('structure')
  })
})

function sourcePin(name: string): ConsoleConversationFleetSourceFile {
  return {
    kind: 'task_file',
    task_id: 'btk_source',
    target_path: name,
    file: { rel: `uploads/${name}`, name, sha256: 'c'.repeat(64), size_bytes: 123 }
  }
}

describe('conversation fleet person delivery', () => {
  it('preserves exact source files, summary, people, action and due date in a delivery receipt stage', () => {
    const request = input()
    request.draft.recipients.push({ kind: 'person', key: 'person', id: 'emp_uma', name: 'Uma' })
    request.draft.handoff = {
      task: { id: 'btk_target', title: 'Target task' },
      includeSummary: true,
      deliverables: { kind: 'files', paths: ['/Users/maintainer/main-next/report.md'] },
      action: 'approve',
      dueAt: '2026-09-14T12:00:00Z'
    }
    request.draft.note = 'Please approve the attached report.'
    request.sourceSummaryFile = sourcePin('summary.md')
    request.sourceDeliverableFiles = [sourcePin('report.md')]
    request.sourceDeliverables = { kind: 'files', paths: ['report.md'] }
    const expected = buildConversationFleetWorkflow(request)
    const delivery = expected.classification.steps[1]!
    expect(delivery).toMatchObject({
      key: 'step-2-person-1',
      title: 'Deliver to Uma',
      actor_type: 'mechanical',
      actor_id: 'stop_rule:person_handoff',
      action: 'notify',
      after: [],
      person_handoff: {
        version: 1,
        approved: true,
        recipient_employee_id: 'emp_uma',
        task_id: 'btk_target',
        action: 'approve',
        note: request.draft.note,
        include_summary: true,
        due_at: request.draft.handoff.dueAt,
        deliverables: { kind: 'files', paths: ['report.md'] },
        source_files: request.sourceDeliverableFiles,
        summary_file: request.sourceSummaryFile
      }
    })
    expect(delivery.repo).toBeUndefined()
    expect(delivery.machine).toBeUndefined()
    expect(() => assertConversationFleetPreview(expected, previewFor(expected))).not.toThrow()
  })

  it('preserves manifests and receipt ordering between agent stages without requiring the human response', () => {
    const request = input()
    request.draft.after = [
      { kind: 'person', key: 'person', id: 'emp_uma', name: 'Uma' },
      {
        kind: 'agent',
        key: 'review',
        actor: { agent: 'claude' },
        presetId: 'review',
        instructions: 'Review the result.',
        rounds: 1
      }
    ]
    delete request.repo
    delete request.baseBranch
    request.workspace = { kind: 'folder', host: 'mw0004', allocation: 'job' }
    const expected = buildConversationFleetWorkflow(request)
    expect(expected.classification.steps.map((step) => step.after)).toEqual([
      [],
      ['step-1'],
      ['step-1', 'step-2-person-1']
    ])
    expect(expected.classification.steps[1]!.person_handoff).toMatchObject({
      task_id: null,
      include_summary: false,
      deliverables: {
        kind: 'manifest',
        manifestPath: '.omni/runs/dispatch_12345678/step-1/manifest.md'
      }
    })
    expect(expected.classification.steps[1]!.workspace).toBeUndefined()
    expect(expected.classification.steps[1]!.person_handoff!.action).toBeUndefined()
    expect(() => assertConversationFleetPreview(expected, previewFor(expected))).not.toThrow()
  })

  it('keeps distinct recipient receipt identities and waits for all before the next agent', () => {
    const request = input()
    request.draft.recipients.push(
      { kind: 'person', key: 'one', id: 'emp_one', name: 'One' },
      { kind: 'person', key: 'two', id: 'emp_two', name: 'Two' }
    )
    request.sourceSummaryFile = sourcePin('summary.md')
    request.draft.after = [
      {
        kind: 'agent',
        key: 'review',
        actor: { agent: 'claude' },
        presetId: 'review',
        instructions: 'Review.',
        rounds: 1
      }
    ]
    const expected = buildConversationFleetWorkflow(request)
    expect(expected.classification.steps.map((step) => step.key)).toEqual([
      'step-1',
      'step-2-person-1',
      'step-2-person-2',
      'step-3'
    ])
    expect(expected.classification.steps[3]!.after).toEqual([
      'step-1',
      'step-2-person-1',
      'step-2-person-2'
    ])
  })

  it('freezes source manifest expansion as exact files while preserving the original manifest evidence', () => {
    const request = input()
    request.draft.recipients.push({ kind: 'person', key: 'one', id: 'emp_one', name: 'One' })
    request.draft.handoff = {
      task: null,
      includeSummary: false,
      deliverables: { kind: 'manifest', manifestPath: '/Users/maintainer/main-next/manifest.md' }
    }
    request.sourceDeliverables = { kind: 'manifest', manifestPath: 'manifest.md' }
    request.sourceDeliverableFiles = [sourcePin('manifest.md'), sourcePin('report.md')]
    expect(() => buildConversationFleetWorkflow(request)).toThrow(
      'files declared by the source handoff manifest'
    )
    request.sourceDeliverablePaths = ['report.md']
    const payload = buildConversationFleetWorkflow(request).classification.steps[1]!.person_handoff!
    expect(payload.deliverables).toEqual({ kind: 'files', paths: ['report.md'] })
    expect(payload.source_files).toEqual(request.sourceDeliverableFiles)
    request.sourceDeliverablePaths = ['unfrozen.md']
    expect(() => buildConversationFleetWorkflow(request)).toThrow(
      'no matching frozen file versions'
    )
  })

  it.each([
    'recipient_employee_id',
    'action',
    'due_at',
    'note',
    'include_summary',
    'deliverables',
    'source_files',
    'summary_file'
  ] as const)('refuses a preview changing the handoff %s', (field) => {
    const request = input()
    request.draft.recipients.push({ kind: 'person', key: 'one', id: 'emp_one', name: 'One' })
    request.sourceSummaryFile = sourcePin('summary.md')
    const expected = buildConversationFleetWorkflow(request)
    const preview = previewFor(expected)
    Object.assign(preview.graph.nodes[1]!.person_handoff!, { [field]: 'changed' })
    expect(() => assertConversationFleetPreview(expected, preview)).toThrow('changed stage')
  })

  it('refuses changed identity proof or an AI replacement for the receipt stage', () => {
    const request = input()
    request.draft.after = [{ kind: 'person', key: 'one', id: 'emp_one', name: 'One' }]
    const expected = buildConversationFleetWorkflow(request)
    const preview = previewFor(expected)
    preview.graph.nodes[1]!.person_handoff!.participants.director.employee_id = 'emp_other'
    expect(() => assertConversationFleetPreview(expected, preview)).toThrow('changed stage')
    const replaced = previewFor(expected)
    replaced.graph.nodes[1]!.actor_type = 'ai'
    expect(() => assertConversationFleetPreview(expected, replaced)).toThrow('changed stage')
  })
})

it('preserves ordered opaque OpenRouter candidates and refuses altered preview routes', () => {
  const request = input()
  request.machine = 'mw0002'
  const openrouterCandidates = ['x-ai/grok-4:exact', 'google/gemini-custom:free']
  request.draft.recipients = [
    {
      ...recipient(),
      agent: 'omp',
      model: `openrouter/${openrouterCandidates[0]}`,
      openrouterCandidates
    }
  ]
  const workflow = buildConversationFleetWorkflow(request)
  expect(workflow.classification.steps[0].openrouter_candidates).toEqual(openrouterCandidates)
  const preview = previewFor(workflow)
  expect(() => assertConversationFleetPreview(workflow, preview)).toThrow()
  preview.graph.nodes[0].openrouter_candidates = [...openrouterCandidates]
  expect(() => assertConversationFleetPreview(workflow, preview)).not.toThrow()
  preview.graph.nodes[0].openrouter_candidates.reverse()
  expect(() => assertConversationFleetPreview(workflow, preview)).toThrow()
})
