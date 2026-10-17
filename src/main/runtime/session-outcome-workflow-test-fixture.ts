import { workflowProofFixture } from './session-outcome-workflow-proof-fixture'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { expect, vi } from 'vitest'
import { outcomeRuntimeFixture } from './session-outcome-runtime-test-fixture'
import { createOrchestrationCaller } from './build-review/build-review-rpc-call'
import { installSessionOutcomeHandoffTransport } from './session-outcome-handoff'
import {
  installSessionOutcomeWorkflowPort,
  type SessionOutcomeWorkflowPort
} from './session-outcome-workflow-port'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcomeDefinition } from '../../shared/session-outcome-types'
import type { SessionOutcomeWorkflowPreview } from '../../shared/session-outcome-workflow'
import type { ConsoleWorkflowJob, ConsoleWorkflowNode } from '../../shared/console-workflow-types'

export const workflowFixtures: ReturnType<typeof outcomeRuntimeFixture>[] = []
const sha = 'a'.repeat(64)
export const workflowDefinition: SessionOutcomeDefinition = {
  id: 'build',
  title: 'Produce the actual deliverable',
  finish: 'my-review',
  dependsOn: [],
  stepIds: ['producer'],
  conditions: [
    { id: 'file', kind: 'file', target: 'report.md' },
    { id: 'human', kind: 'review', target: 'Sal final acceptance' }
  ],
  actions: []
}
export async function sessionOutcomeWorkflowFixture() {
  const f = outcomeRuntimeFixture(() => ({ body: 'not used' }))
  workflowFixtures.push(f)
  const sourceContext = vi.spyOn(f.runtime, 'readSessionOutcomeSourceContext').mockResolvedValue({
    paneKey: 'source',
    handle: 'source',
    processIncarnation: 'test:source:1',
    agent: 'codex',
    model: 'gpt-5.6-terra',
    effort: 'high',
    summary: 'The source completed its analysis and wrote source-report.md.',
    files: ['source-report.md']
  })
  installSessionOutcomeHandoffTransport({ principal: async () => 'person', hub: {} as never })
  const call = createOrchestrationCaller(f.runtime)
  const created = await call<{ run: { id: string }; projectionTaskId: string }>(
    'orchestration.runCreate',
    {
      from: 'source',
      objective: 'Full original outcome remains pending',
      hubTaskId: 'btk_nativeoutcomes'
    }
  )
  const chain: SessionChain = {
    id: 'admitted',
    workspacePath: f.workspace,
    worktreeId: 'folder:outcome',
    hostId: 'local',
    sourcePaneKey: 'source',
    sourceRowKey: 'source',
    auto: true,
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 1,
    steps: [
      {
        id: 'producer',
        agent: 'codex',
        model: 'gpt-5.6-terra',
        effort: 'high',
        prompt: 'Write the chosen report, then stop for review.',
        status: 'queued'
      }
    ]
  }
  let jobs: ConsoleWorkflowJob[] = []
  const workflows = new Map<string, ConsoleWorkflowJob[]>()
  const port: SessionOutcomeWorkflowPort = {
    captureSourceInputs: vi.fn<NonNullable<SessionOutcomeWorkflowPort['captureSourceInputs']>>(
      async (_runtime, input) => ({
        files: [
          ...input.selectedSourcePaths.map((path) => ({
            path,
            content: readFileSync(join(f.workspace, path), 'utf8')
          })),
          input.sourceResult
        ].map(({ path, content }, index) => ({
          rel: `uploads/source-${index}.md`,
          name: path.split('/').at(-1)!,
          sha256: createHash('sha256').update(content).digest('hex'),
          size_bytes: Buffer.byteLength(content),
          target_path: path
        }))
      })
    ),
    cancellation: vi.fn(() => {
      throw new Error('No cancellation fixture installed')
    }),
    preview: vi.fn<SessionOutcomeWorkflowPort['preview']>(async (_runtime, input) => {
      const nodes = input.stages.flatMap((stage): ConsoleWorkflowNode[] => {
        const captured = input.currentInputs?.find((entry) => entry.stage_key === stage.key)
        const current_source = captured && {
          schema_version: 1 as const,
          kind: 'current_task_files' as const,
          root_task_id: input.taskId,
          stage_key: stage.key!,
          mode: captured.mode,
          snapshot_digest: sha,
          producer: captured.producer!,
          ...(captured.git ? { git: captured.git } : {}),
          files: captured.files.map(({ target_path, ...file }) => ({
            kind: 'task_file' as const,
            task_id: input.taskId,
            file,
            target_path
          }))
        }
        const [provider, model] = stage.actor!.split(':')
        const node: ConsoleWorkflowNode = {
          key: stage.key!,
          title: stage.title,
          brief: stage.prompt!,
          actor_type: 'ai',
          actor_id: stage.actor!,
          action: 'execute',
          after: stage.after!,
          owned_paths: null,
          provider,
          model,
          effort: stage.effort,
          placement: 'local',
          ...(current_source ? { current_source } : {})
        }
        if (captured?.mode !== 'review-source') {
          return [node]
        }
        const reviewers = stage.loop!.participants.slice(1).map((actor, index) => {
          const [provider, model] = actor.split(':')
          return Object.assign(
            {
              ...node,
              key: `${stage.key}__loop_r1_p${index + 1}`,
              actor_id: actor,
              provider,
              model,
              action: 'review' as const,
              workspace: { kind: 'folder' as const, host: 'local' as const, path: f.workspace },
              source_files: current_source!.files,
              loop_stage: { stage_key: stage.key!, role: 'participant', round: 1 }
            },
            { artifact_result: { path: 'work-result.json', format: 'json', max_bytes: 65536 } }
          )
        })
        const decider = workflowProofFixture().workflow.preview.graph.nodes.at(-1)!
        return [
          ...reviewers,
          {
            ...decider,
            key: `${stage.key}__loop_r1_decide`,
            after: reviewers.map((entry) => entry.key),
            current_source,
            loop_stage: { stage_key: stage.key!, role: 'decide', round: 1 },
            mechanical_execution: {
              ...decider.mechanical_execution!,
              input: {
                ...decider.mechanical_execution!.input,
                stage_key: stage.key!,
                participant_node_keys: reviewers.map((entry) => entry.key)
              }
            }
          }
        ]
      })
      const graph = {
        schema_version: 1 as const,
        mode: 'sequential' as const,
        title: 'Frozen plan',
        prompt: 'Whole outcome',
        company: 'OmniRogue',
        owner: 'emp_sal',
        policy: {},
        nodes,
        columns: nodes.map((node) => [node.key]),
        digest: sha,
        dispatch_id: `wf_${input.operationId.replaceAll('-', '')}`
      }
      jobs = graph.nodes
        .filter((node) => node.actor_type === 'ai')
        .map((node, index) => ({
          id: `job_${graph.dispatch_id.slice(3, 11)}${index}`,
          task_id: `btk_child${index}`,
          node_id: node.key,
          title: node.title,
          status: 'queued',
          actor_type: 'ai',
          provider: node.provider!,
          model: node.model!,
          effort: node.effort ?? null,
          repo: null,
          machine: null,
          pr_url: null,
          attempt: null,
          lease_generation: null,
          owned_paths: null,
          updated_at: null,
          policy: {
            workflow: {
              version: 1,
              digest: sha,
              mode: 'sequential',
              dispatch_id: graph.dispatch_id,
              workflow_id: graph.dispatch_id,
              placement: 'local',
              key: node.key,
              actor_type: 'ai',
              actor_id: node.actor_id,
              action: node.action,
              ...(node.current_source ? { current_source: node.current_source } : {}),
              ...(node.loop_stage ? { loop_stage: node.loop_stage } : {}),
              after: [],
              after_keys: [],
              require_merged: [],
              approval_ancestors: []
            }
          },
          blockers: [],
          workflow_state: 'ready',
          can_decide: false
        }))
      workflows.set(graph.dispatch_id, jobs)
      return {
        ok: true,
        graph,
        digest: sha,
        workflow_id: graph.dispatch_id,
        admission: {
          filing_root_task_id: input.taskId,
          filing_root_expected_revision: 7,
          objective: {
            goal_id: 'goal',
            title: 'Whole original task',
            desired_result: 'Deliver then human acceptance',
            acceptance_policy: { full: true },
            verification_policy: { native: true }
          },
          org_unit_id: 'org_actual',
          expected_authority_epoch: 3
        }
      } satisfies SessionOutcomeWorkflowPreview
    }),
    admit: vi.fn<SessionOutcomeWorkflowPort['admit']>(async (preview) => {
      expect(f.service.get(chain.id).outcomeSet!.workflow).toMatchObject({
        phase: 'admitting',
        preview
      })
      const durable = JSON.parse(readFileSync(join(f.workspace, '.omni', 'state.json'), 'utf8'))
      expect(durable.sessionChains[0].outcomeSet.workflow).toEqual(
        f.service.get(chain.id).outcomeSet!.workflow
      )
      return {
        ok: true,
        data: {
          ok: true,
          workflow_id: preview.workflow_id,
          receipt: {
            receipt: {
              workflow_id: preview.workflow_id,
              revision: {
                workflow_id: preview.workflow_id,
                revision_id: 'rev_real',
                graph_digest: 'b'.repeat(64)
              }
            }
          },
          jobs
        }
      }
    }),
    observe: vi.fn<SessionOutcomeWorkflowPort['observe']>(async (workflowId) => ({
      ok: true,
      data: { ok: true, workflow_id: workflowId, jobs: workflows.get(workflowId)! }
    })),
    receipt: vi.fn<SessionOutcomeWorkflowPort['receipt']>(async () => null),
    list: vi.fn<SessionOutcomeWorkflowPort['list']>(async () => ({ ok: true, data: [] })),
    start: vi.fn<SessionOutcomeWorkflowPort['start']>(async () => {
      expect(f.service.get(chain.id).outcomeSet!.workflow!.activations[0]!.state).toBe('requested')
      return {
        ok: false,
        error: { code: 'lost_response', message: 'Activation response was lost' }
      }
    })
  }
  installSessionOutcomeWorkflowPort(port)
  return { f, chain, port, created, sourceContext, jobs: () => jobs }
}
