import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { installFleetDispatchUiSource, seedFleetDispatchUiSource } from './fleet-dispatch-ui-source'
import type { ConsoleConversationFleetPreviewRequest } from '../../../src/shared/console-conversation-fleet-types'
import type { ConsoleWorkflowJob } from '../../../src/shared/console-workflow-types'
import type { ExactHandoffFile } from '../../../src/shared/console-handoff-contract'

export const FLEET_UI_FIXTURE_TITLE = 'Fixture conversation · fleet UI'
export const FLEET_UI_FIXTURE_WORKFLOW = 'wf_rendered_fixture'
export const FLEET_UI_FIXTURE_MACHINE = 'fixture-rented-mac'

/** All service replies belong to this disposable Electron process; no live account is used. */
export async function installFleetDispatchUiFixture(app: ElectronApplication): Promise<void> {
  const candidatePath = path.resolve(process.cwd())
  const appPath = await app.evaluate(({ app }) => app.getAppPath())
  if (path.resolve(appPath) !== candidatePath) {
    throw new Error(`Expected candidate ${candidatePath}; Electron loaded ${appPath}`)
  }
  await app.evaluate(
    ({ ipcMain }, fixture) => {
      const ok = <T>(data: T) => ({ ok: true, data })
      const register = (name: string, fn: (input: unknown) => unknown) => {
        ipcMain.removeHandler(name)
        ipcMain.handle(name, (_event, input) => fn(input))
      }
      const digest = 'd'.repeat(64)
      const filing = { company_slug: 'fixture', org_unit_id: 'ou_fixture', goal_id: 'goal_fixture' }
      let prepared: ConsoleConversationFleetPreviewRequest | null = null
      let jobs: ConsoleWorkflowJob[] = []
      const machine = fixture.machine
      const model = 'fixture-model'
      const uploadedFiles: { rel: string; size: number; sha256: string }[] = []
      register('consoleWorkflows:readFleetReceipts', () => ok([]))
      register('consoleWorkflows:fleetInventory', () =>
        ok({
          providers: ['codex'],
          people: [],
          repositories: [{ id: 'Fixture/project' }],
          models_fallback: false,
          models: [
            {
              id: `codex:${model}`,
              provider: 'codex',
              model,
              default: true,
              supported_efforts: ['high'],
              seat_ready: true,
              aliases: []
            }
          ],
          machines: [
            {
              host: machine,
              allowed: true,
              ready: true,
              slots: 2,
              running: 0,
              last_beat: new Date().toISOString(),
              execution_capabilities: [
                {
                  provider: 'codex',
                  available: true,
                  models: [model],
                  efforts: ['high'],
                  resume: true,
                  readonly: true,
                  native_execution: true,
                  pinned_task_inputs: true,
                  source_snapshot: true,
                  account_usage: {
                    version: 1,
                    selected_account_ref: '11111111-1111-4111-8111-111111111111',
                    account_generation: '22222222-2222-4222-8222-222222222222',
                    usage: {
                      provider: 'codex',
                      status: 'ok',
                      updatedAt: Date.now(),
                      error: null,
                      session: {
                        usedPercent: 10,
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
        })
      )
      register('consoleWorkflows:fleetTaskContext', () =>
        ok({
          ok: true,
          task_id: 'btk_fixturefleet',
          expected_revision: 4,
          supported: true,
          filing
        })
      )
      register('consoleWorkflows:previewFleetTask', (input) => {
        prepared = input as ConsoleConversationFleetPreviewRequest
        const request = prepared
        const nodes = request.classification.steps.map((step) => {
          const [provider, ...models] = (step.actor_id ?? 'codex').split(':')
          return {
            ...step,
            key: step.key!,
            actor_type: step.actor_type ?? 'ai',
            actor_id: provider,
            provider,
            model: models.join(':'),
            action: step.action ?? 'execute',
            after: step.after ?? [],
            owned_paths: null,
            brief: step.brief ?? step.prompt ?? '',
            source_files: request.sourceFiles
          }
        })
        return ok({
          workflow_id: fixture.workflow,
          digest,
          jobs: [],
          filing,
          reviewer: { provider: 'codex', model, effort: 'high' },
          admission: {
            task_id: request.taskId,
            expected_revision: 4,
            context_digest: 'c'.repeat(64),
            adopt_stage: nodes[0].key
          },
          graph: {
            schema_version: 1,
            mode: request.classification.execution_mode ?? 'single_shot',
            title: fixture.title,
            prompt: request.prompt,
            company: 'fixture',
            owner: 'emp_fixture',
            policy: {},
            nodes,
            columns: nodes.map((node) => [node.key]),
            dispatch_id: fixture.workflow,
            digest
          }
        })
      })
      register('consoleWorkflows:admitFleetTask', () => {
        if (!prepared) {
          throw new Error('Fixture requires the rendered review before admission')
        }
        const request = prepared
        jobs = request.classification.steps.map((step, index) => ({
          id: `job_fixture_${index}`,
          task_id: index === 0 ? request.taskId : `btk_fixture_stage_${index}`,
          node_id: request.taskId,
          title: step.title,
          status: index ? 'blocked' : 'running',
          actor_type: 'ai',
          provider: 'codex',
          model,
          effort: 'high',
          repo: 'Fixture/project',
          machine,
          pr_url: null,
          attempt: 1,
          lease_generation: 1,
          owned_paths: null,
          updated_at: new Date().toISOString(),
          blockers: [],
          workflow_state: index ? 'blocked' : 'running',
          can_decide: false,
          policy: {
            workflow: {
              version: 1,
              digest,
              mode: 'sequential',
              dispatch_id: fixture.workflow,
              key: step.key!,
              actor_type: 'ai',
              actor_id: 'codex',
              action: step.action ?? 'execute',
              after: [],
              after_keys: step.after ?? [],
              require_merged: [],
              approval_ancestors: [],
              // The service omits placement for its default fleet execution.
              source_task_id: request.taskId,
              source: {
                session_ref: request.source.sessionRef,
                ...(request.source.sessionId ? { session_id: request.source.sessionId } : {}),
                ...(request.source.capturedAt ? { captured_at: request.source.capturedAt } : {})
              }
            }
          }
        }))
        return ok({ workflow_id: fixture.workflow, jobs, receipt: { fixture: true } })
      })
      register('consoleWorkflows:listJobs', () =>
        ok({
          jobs,
          conversation_source_scope: 'directing_person'
        })
      )
      register('consoleWorkflows:getWorkflow', () => ok({ workflow_id: fixture.workflow, jobs }))
      register('consoleWorkflows:getJob', (input) => {
        const job = jobs.find((item) => item.id === (input as { jobId: string }).jobId)
        return ok({ ...job, placement: 'fleet', exact_prompt: 'Fixture: improve this proposal.' })
      })
      register('consoleWorkflows:readJobEvidence', (input) => {
        const request = input as { jobId: string; after?: number }
        const entries = [
          {
            id: 1,
            kind: 'input',
            text: 'Fixture: improve this proposal.',
            at: '2026-09-12T12:00:00Z'
          },
          {
            id: 2,
            kind: 'provider_event',
            text: JSON.stringify({
              type: 'item.completed',
              item: {
                type: 'agent_message',
                text: 'Fixture result: the proposal now has a clear next step.'
              }
            }),
            at: '2026-09-12T12:01:00Z'
          }
        ]
        return ok({
          job_id: request.jobId,
          attempt: 1,
          lease_generation: 1,
          host: machine,
          session_id: 'fixture-native-session',
          provider: 'codex',
          entries: entries.filter((entry) => entry.id > (request.after ?? 0)),
          next_after: 2,
          has_more: false,
          complete: false
        })
      })
      register('consoleWorkflows:listJobEvents', (input) =>
        ok({
          job_id: (input as { jobId: string }).jobId,
          next_after: 1,
          has_more: false,
          events: [
            {
              id: 1,
              kind: 'runner_started',
              machine,
              created_at: '2026-09-12T12:00:00Z',
              detail: { note: 'Fixture runner started; simulated backend evidence.' }
            }
          ]
        })
      )
      register('consoleHandoffs:recipients', () => ok({ employees: [] }))
      register('consoleHandoffs:taskFiles', () => ok({ files: uploadedFiles }))
      register('consoleHandoffs:uploadFile', (input) => {
        const { file } = input as { file: ExactHandoffFile }
        uploadedFiles.push({ rel: `uploads/${file.name}`, size: file.size, sha256: file.sha256 })
        return ok({ path: `uploads/${file.name}`, sha256: file.sha256 })
      })
    },
    {
      title: FLEET_UI_FIXTURE_TITLE,
      workflow: FLEET_UI_FIXTURE_WORKFLOW,
      machine: FLEET_UI_FIXTURE_MACHINE
    }
  )
  await installFleetDispatchUiSource(app)
}

export function seedFleetDispatchUiConversation(page: Page): Promise<void> {
  return seedFleetDispatchUiSource(page, FLEET_UI_FIXTURE_TITLE)
}
