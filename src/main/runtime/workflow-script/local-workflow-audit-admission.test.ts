import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyFileSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createLocalWorkflowAuditDraft } from '../../../shared/workflow-audit-draft'
import { localWorkflowAnchorSchema } from '../../../shared/local-workflow-session-schema'
import type { LocalWorkflowStartRequest } from '../../../shared/local-workflow-rpc'
import { getAppEnvironment, setAppEnvironment } from '../../../shared/app-environment'
import { prepareAuditWorkflowAdmission } from './local-workflow-audit-admission'
import { LocalWorkflowHost } from './local-workflow-host'
import {
  hostCatalog,
  hostTempDirectory,
  closeHostFixtures
} from './local-workflow-host.test-fixtures'
import { OrchestrationDb } from '../orchestration/db'
import { WorkflowScriptSlots } from './workflow-script-slots'
import { captureWorkflowOwner } from './workflow-owner-claim'
import { createWorkflowLocalProcessLaunch } from './workflow-local-process-launch'
import {
  auditFixtureResponse,
  AUDIT_FIXTURE_REVISION
} from '../../../../config/scripts/workflows/fixtures/audit-pipeline-fixture'
import { auditResultMarkdown } from './local-workflow-audit-projection'

afterEach(closeHostFixtures)

async function fixture() {
  const path = await hostTempDirectory('audit-admission-')
  const sourceFile = join(path, 'sources.jsonl')
  copyFileSync(resolve('config/scripts/workflows/fixtures/audit-sources.jsonl'), sourceFile)
  const request: LocalWorkflowStartRequest = {
    worktree: 'folder-workspace',
    conversationId: 'audit-tab',
    requestId: 'audit-start',
    preset: 'discover',
    draft: {
      ...createLocalWorkflowAuditDraft('Find repeated setup work.'),
      audit: { version: 1, sourceFile, format: 'sources-jsonl' },
      concurrency: 2,
      seats: [{ id: 'reader', agent: 'claude', accountId: 'claude-account' }]
    }
  }
  return {
    path,
    sourceFile,
    request,
    workspace: { id: request.worktree, path, label: 'Folder', executionHost: 'local' as const },
    catalog: vi.fn(async () => hostCatalog),
    requestDigest: 'test-digest',
    slotLimit: 2
  }
}

describe('Audit public admission', () => {
  it('captures a folder corpus and derives frozen roles and budgets on the host', async () => {
    const f = await fixture()
    f.request.draft.callLimit = 1
    const prepared = await prepareAuditWorkflowAdmission(f)
    expect(prepared.snapshot.graph).toBeUndefined()
    expect(prepared.snapshot.access).toBeUndefined()
    expect(prepared.snapshot.audit?.corpus.sources).toHaveLength(2)
    expect(prepared.snapshot.audit?.version).toBe(5)
    expect(prepared.snapshot.audit?.plannerSeatIds).toEqual(['reader', 'reader', 'reader'])
    expect(prepared.callLimit).toBeGreaterThan(1)
    expect(prepared.budgetLimit).toBe(prepared.callLimit * 3)
    expect(prepared.snapshot.host.workspaceId).toBe('folder-workspace')
  })

  it.each(['fleet', 'named-host', 'ssh-workspace', 'unproven-host'])(
    'refuses %s before opening a missing corpus or reading account state',
    async (kind) => {
      const f = await fixture()
      f.request.draft.audit!.sourceFile = join(f.path, 'missing.jsonl')
      if (kind === 'fleet') {
        f.request.draft.runsOn = 'fleet'
      }
      if (kind === 'named-host') {
        f.request.draft.runsOnHost = 'studio'
      }
      if (kind === 'ssh-workspace' || kind === 'unproven-host') {
        delete (f.workspace as { executionHost?: string }).executionHost
      }
      await expect(prepareAuditWorkflowAdmission(f)).rejects.toThrow('computer holding the corpus')
      expect(f.catalog).not.toHaveBeenCalled()
    }
  )

  it('refuses credential paths, unknown draft fields and answer-only review teams', async () => {
    const f = await fixture()
    const hidden = join(f.path, '.aws')
    mkdirSync(hidden)
    copyFileSync(f.sourceFile, join(hidden, 'sources.jsonl'))
    f.request.draft.audit!.sourceFile = join(hidden, 'sources.jsonl')
    await expect(prepareAuditWorkflowAdmission(f)).rejects.toThrow('logins, keys or app data')
    f.request.draft.audit!.sourceFile = f.sourceFile
    Object.assign(f.request.draft.audit!, { corpus: {} })
    await expect(prepareAuditWorkflowAdmission(f)).rejects.toThrow('Unrecognized key')
    delete (f.request.draft.audit as unknown as Record<string, unknown>).corpus
    f.request.draft.seats[0] = { id: 'reader', agent: 'gemini', accountId: 'gemini-account' }
    f.catalog.mockResolvedValue([
      {
        ...hostCatalog[0],
        agent: 'gemini',
        accountId: 'gemini-account',
        models: [
          { ...hostCatalog[0].models[0], resolvedModelId: 'gemini-model', lineage: 'google' }
        ]
      }
    ])
    await expect(prepareAuditWorkflowAdmission(f)).rejects.toThrow('eligible to review')
  })

  it('persists an unfinished Audit selection and pending Start without converting it', () => {
    const draft = createLocalWorkflowAuditDraft()
    expect(
      localWorkflowAnchorSchema.parse({ preset: 'discover', prompt: '', draft }).draft?.audit
    ).toEqual(draft.audit)
  })

  it('refuses app data even when the configured profile path is a symlink', async () => {
    const f = await fixture()
    const profile = join(f.path, 'profile-real')
    const alias = join(f.path, 'profile-alias')
    mkdirSync(profile)
    symlinkSync(profile, alias, 'junction')
    copyFileSync(f.sourceFile, join(profile, 'sources.jsonl'))
    f.request.draft.audit!.sourceFile = join(profile, 'sources.jsonl')
    await expect(prepareAuditWorkflowAdmission({ ...f, appData: alias })).rejects.toThrow(
      'logins, keys or app data'
    )
  })

  it('never displays a superseded report when a required revision is missing', () => {
    const results = new Map<string, unknown>([
      ['audit/synthesize', { markdown: 'Old report' }],
      ['audit/critic', { verdict: 'revise' }]
    ])
    expect(auditResultMarkdown(results)).toBeUndefined()
    results.set('audit/revise', { markdown: 'Corrected report' })
    expect(auditResultMarkdown(results)).toBe('Corrected report')
  })

  it('starts, projects and restores through the host without rereading a removed corpus', async () => {
    const f = await fixture()
    const previous = getAppEnvironment()
    const appData = join(f.path, 'state')
    mkdirSync(appData)
    setAppEnvironment({ ...previous, getPath: () => appData })
    const db = new OrchestrationDb(':memory:')
    mkdirSync(join(f.path, 'attempts'))
    const launches: string[] = []
    const options = {
      db: db.db,
      owner: await captureWorkflowOwner('audit-admission-test'),
      slots: new WorkflowScriptSlots(2),
      resolve: async () => f.workspace,
      catalog: f.catalog,
      listScope: async () => [],
      freezeScope: async () => ({ evidence: '', sources: [], coverage: [] }),
      attestNativeResult: () => {},
      launch: (
        snapshot: Parameters<
          NonNullable<ConstructorParameters<typeof LocalWorkflowHost>[0]['launch']>
        >[0],
        executionId: string,
        fence: number
      ) =>
        createWorkflowLocalProcessLaunch({
          directory: join(f.path, 'attempts'),
          executionId,
          fence,
          hostId: 'audit-test',
          ownerIncarnation: 'test',
          timeoutMs: 10_000,
          maxOutputBytes: 64 * 1024,
          command: (input) => {
            launches.push(input.call.id)
            const seat = snapshot.seats.find((item) => item.id === input.call.seatId)!
            return {
              program: process.execPath,
              args: [resolve('config/scripts/workflows/fixtures/native-workflow-fixture.cjs')],
              cwd: f.path,
              input: JSON.stringify({
                agent: seat.agent,
                model: seat.model,
                attemptId: input.attemptId,
                ledgerPath: join(f.path, 'launches.jsonl'),
                value: auditFixtureResponse(input.call)
              })
            }
          }
        })
    }
    try {
      const host = new LocalWorkflowHost(options)
      const setup = await host.setup(f.request)
      expect(setup.auditSupport).toEqual({ version: 1 })
      const start = await host.start(f.request)
      if ('rejected' in start) {
        throw new Error(start.reason)
      }
      await vi.waitFor(
        () => expect(host.project(start.executionId)).toMatchObject({ state: 'completed' }),
        {
          timeout: 20_000
        }
      )
      const view = await host.show({ ...f.request, ...start })
      expect(view.audit).toEqual({ version: 1, sourceCount: 2, chunkCount: 1 })
      expect(view.discoverRun).toBeUndefined()
      expect(view.result?.markdown).toContain(AUDIT_FIXTURE_REVISION)
      expect(view.result?.markdown).toContain('has not received a further semantic review')
      expect(view.calls.every((call) => call.model === 'claude-concrete')).toBe(true)
      expect(view.stages.map((stage) => stage.id)).toContain('audit-verify')
      const count = launches.length
      renameSync(f.sourceFile, `${f.sourceFile}.removed`)
      expect(await host.start(f.request)).toEqual(start)
      const restored = await new LocalWorkflowHost(options).show({ ...f.request, ...start })
      expect(restored.result).toEqual(view.result)
      expect(launches).toHaveLength(count)
      writeFileSync(f.sourceFile, 'changed corpus')
      expect(
        await host.start({ ...f.request, draft: { ...f.request.draft, prompt: 'Changed' } })
      ).toEqual({ rejected: true, reason: 'Conflicting workflow Start request' })
    } finally {
      db.close()
      setAppEnvironment(previous)
    }
  }, 30_000)
})
