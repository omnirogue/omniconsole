import { describe, expect, it, vi } from 'vitest'
import { createLocalWorkflowDraft } from '../../../shared/local-workflow-draft'
import type { LocalWorkflowAccess } from '../../../shared/local-workflow-draft'
import { withDiscoverScreen } from '../../../shared/workflow-discover-screen.test-fixture'
import { workflowSetFind } from '../../../shared/workflow-graph-find'
import { normalizeWorkflowSpec } from '../../../shared/workflow-graph-normalize'
import {
  workflowTemplate,
  type WorkflowTemplateKey
} from '../../../shared/workflow-graph-templates'
import { FIND_RULES } from './graph/graph-plan-types'
import { WEB_RULES } from './graph/graph-web-types'
import { DECISION_RULES } from './graph/graph-decision-rules'
import { EVIDENCE_RULES } from './graph/graph-pre-verify'
import { resolveDecisionContracts } from '../../../shared/decision-contracts/decision-points'
import { readDiscoverRunSource } from './discover-run-source'
import { prepareGraphWorkflowAdmission } from './local-workflow-graph-admission'
import { hostCatalog } from './local-workflow-host.test-fixtures'
import {
  LOCAL_WORKFLOW_RUN_TEMPLATES,
  localWorkflowRunSpec
} from '../../../shared/local-workflow-run-request'

vi.mock('./discover-run-source', () => ({
  readDiscoverRunSource: vi.fn(async () => ({
    commit: 'a'.repeat(40),
    branch: 'main-next',
    dirty: false
  }))
}))

const ROOT = { path: '/work/app', device: '1', inode: '2' }
const bundleQuickScope = vi.fn(async () => ({
  evidence: '\n--- src/a.ts ---\n   1| export {}\n',
  sources: [{ ref: 'src/a.ts', description: 'src/a.ts (1 line)' }],
  coverage: ['src/a.ts']
}))

async function admit(
  template: WorkflowTemplateKey,
  access: LocalWorkflowAccess,
  change: (spec: ReturnType<typeof workflowTemplate>) => ReturnType<typeof workflowTemplate> = (
    spec
  ) => spec,
  maxAgents?: number,
  executionHost?: 'local',
  scopeIds: string[] = []
) {
  const draft = createLocalWorkflowDraft('council', 'Name the bakery')
  draft.concurrency = 2
  draft.access = access
  draft.scopeIds = scopeIds
  draft.graph = {
    spec: change(workflowTemplate(template, ['claude', 'codex', 'grok'])),
    team: hostCatalog.map(({ agent, accountId }, index) => ({
      id: `seat-${index + 1}`,
      agent,
      accountId
    })),
    ...(maxAgents !== undefined ? { maxAgents } : {})
  }
  const freezeWorkspaceRoot = vi.fn(async () => ROOT)
  const admitted = await prepareGraphWorkflowAdmission({
    request: {
      worktree: 'workspace-a',
      conversationId: 'conversation-a',
      requestId: 'request-1',
      preset: 'council',
      draft
    },
    workspace: {
      id: 'workspace-a',
      path: ROOT.path,
      label: 'App',
      ...(executionHost ? { executionHost } : {})
    },
    requestDigest: 'digest',
    slotLimit: 6,
    catalog: async () => hostCatalog,
    freezeScope: async () => ({ evidence: '', sources: [], coverage: [] }),
    freezeWorkspaceRoot,
    bundleQuickScope
  })
  return {
    task: admitted.snapshot.task,
    host: admitted.snapshot.host,
    spec: admitted.snapshot.graph!.spec,
    access: admitted.snapshot.access,
    freezeWorkspaceRoot,
    callLimit: admitted.callLimit,
    budgetLimit: admitted.budgetLimit
  }
}

describe('graph admission', () => {
  it('freezes Discover source separately from the mutable workspace path', async () => {
    const admitted = await admit('discover', 'workspace-read')
    expect(admitted.host.discoverSource).toEqual({
      commit: 'a'.repeat(40),
      branch: 'main-next',
      dirty: false
    })
    expect(readDiscoverRunSource).toHaveBeenCalledWith(ROOT.path)
    expect((await admit('discover', 'frozen')).host.discoverSource).toBeUndefined()
  })

  it("attaches Quick Discover's whole-scope bundle, sized for its one reader's seat", async () => {
    bundleQuickScope.mockClear()
    const admitted = await admit('quick-discover', 'workspace-read')
    expect(admitted.task.evidence).toContain('--- src/a.ts ---')
    expect(admitted.host.coverage).toEqual(['src/a.ts'])
    expect(bundleQuickScope).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeIds: [],
        seat: expect.objectContaining({ agent: 'claude' }),
        promptChars: 'Name the bakery'.length
      })
    )
  })

  it('routes complete small selections to Quick plus Verify, falling back for an oversized scope', async () => {
    const quick = await admit('discover', 'workspace-read', undefined, undefined, 'local', [
      'src/a.ts'
    ])
    expect(quick.spec.template).toBe('quick-discover')
    expect(quick.spec.steps.map((step) => step.id)).toEqual(['find', 'verify'])
    expect(quick.host.discoverSource).toEqual({
      commit: 'a'.repeat(40),
      branch: 'main-next',
      dirty: false
    })
    bundleQuickScope.mockRejectedValueOnce(new Error('over budget'))
    const large = await admit('discover', 'workspace-read', undefined, undefined, 'local', ['src/'])
    expect(large.spec.template).toBe('discover')
  })

  it('admits every template omni workflow run offers, and refuses Build + Review', async () => {
    const routes = ['claude', 'codex', 'grok'] as const
    for (const template of LOCAL_WORKFLOW_RUN_TEMPLATES) {
      const spec = localWorkflowRunSpec({ template, prompt: 'x' }, routes)
      await expect(
        admit(template, 'workspace-read', () => spec),
        template
      ).resolves.toBeDefined()
    }
    expect(LOCAL_WORKFLOW_RUN_TEMPLATES).not.toContain('build-review')
    // No template builds it any more; a spec saved by an earlier build still names it.
    const saved = normalizeWorkflowSpec({
      title: 'Build + Review',
      template: 'build-review',
      steps: [
        { id: 'build', kind: 'do', title: 'Build', agents: [{ route: 'claude' }], inputs: [] },
        {
          id: 'review',
          kind: 'review',
          title: 'Review',
          agents: [{ route: 'codex' }, { route: 'grok' }],
          inputs: ['build']
        }
      ],
      repeat: { do: 'build', review: 'review', until: 'approved', maxRounds: 3 }
    })
    expect(saved.template).toBe('build-review')
    await expect(admit('council', 'workspace-read', () => saved)).rejects.toThrow(
      'Build + Review runs through its own executor'
    )
  })

  it('freezes where Find the best saves its results, without letting agents read there', async () => {
    const frozen = await admit('find', 'frozen')
    expect(frozen.host.resultsRoot).toEqual(ROOT)
    // Frozen so a later build replays the run by the rules it was admitted under.
    expect(frozen.host.findRules).toBe(FIND_RULES)
    expect(frozen.host.workspaceRoot).toBeUndefined()
    expect(frozen.access).toBeUndefined()
    const reading = await admit('find', 'workspace-read')
    expect(reading.host).toMatchObject({ workspaceRoot: ROOT, resultsRoot: ROOT })
    expect(reading.freezeWorkspaceRoot).toHaveBeenCalledTimes(1)
  })

  it('runs a check on complete versions only where the agents may read the workspace', async () => {
    const checked = (spec: ReturnType<typeof workflowTemplate>) =>
      workflowSetFind(spec, { versions: true, check: { command: 'pnpm test' } }, [
        'claude',
        'codex',
        'grok'
      ])
    await expect(admit('find', 'frozen', checked)).rejects.toThrow(
      'The check runs in this workspace'
    )
    await expect(admit('find', 'workspace-read', checked)).resolves.toMatchObject({
      access: 'workspace-read'
    })
  })

  it("freezes every JEV decision's contract, so a later build judges the run by the same rules", async () => {
    for (const template of ['council', 'improve', 'find', 'decide'] as const) {
      const { host, spec } = await admit(template, 'workspace-read')
      expect(host.decisionRules).toBe(DECISION_RULES)
      expect(host.contracts).toEqual(resolveDecisionContracts(spec))
      expect(Object.keys(host.contracts!).length).toBeGreaterThan(0)
    }
    // Discover's only JEV decision by default is live verify; a screen put back on it is frozen too.
    expect((await admit('discover', 'workspace-read')).host.contracts).toEqual({
      'verify/verify': 'discover-verify@3'
    })
    expect((await admit('discover', 'workspace-read', withDiscoverScreen)).host.contracts).toEqual({
      'verify/set-aside': 'discover-set-aside@1'
    })
    expect((await admit('find', 'frozen')).host.contracts).toEqual({
      'judge/screen': 'find-screen@2',
      'judge/ballot': 'find-final@1'
    })
  })

  it("freezes the pre-verify's evidence rules for Discover only, when it reads its files", async () => {
    expect((await admit('discover', 'workspace-read')).host.evidenceRules).toBe(EVIDENCE_RULES)
    // Knowledge only has no workspace root, so nothing could re-run its finders' searches.
    const frozen = await admit('discover', 'frozen')
    expect(frozen.host).not.toHaveProperty('workspaceRoot')
    expect(frozen.host).not.toHaveProperty('evidenceRules')
    // Their finders also quote, but Quick Discover has no review and Investigate is out of scope.
    for (const template of ['quick-discover', 'investigate', 'council'] as const) {
      expect((await admit(template, 'workspace-read')).host, template).not.toHaveProperty(
        'evidenceRules'
      )
    }
  })

  it('saves no results for workflows other than Find the best', async () => {
    expect((await admit('improve', 'frozen')).host.resultsRoot).toBeUndefined()
  })

  it('caps the run at Max agents, keeping room for the report', async () => {
    const planned = (await admit('discover', 'workspace-read')).callLimit
    expect(planned).toBeGreaterThan(10)
    expect(await admit('discover', 'workspace-read', undefined, 10)).toMatchObject({
      callLimit: 10,
      budgetLimit: 30
    })
    expect((await admit('discover', 'workspace-read', undefined, planned + 50)).callLimit).toBe(
      planned
    )
    await expect(admit('discover', 'workspace-read', undefined, 1)).rejects.toThrow(
      'Max agents must be at least 2'
    )
    // Improve ends in its own loop, so it has no final step to keep room for.
    await expect(admit('improve', 'frozen', undefined, 3)).rejects.toThrow(
      'Max agents needs a workflow'
    )
  })

  it('admits web rules only for a spec that reads pages, and only on this computer', async () => {
    const reading = (spec: ReturnType<typeof workflowTemplate>) =>
      normalizeWorkflowSpec(
        {
          ...spec,
          steps: spec.steps.map((step) =>
            step.id === 'answer' ? { ...step, web: { urls: ['https://a.example/one'] } } : step
          )
        },
        ['claude', 'codex', 'grok']
      )
    const admitted = await admit('council', 'frozen', reading, undefined, 'local')
    expect(admitted.host.webRules).toBe(WEB_RULES)
    // One host call reads the pages, inside the call bound.
    expect(admitted.callLimit).toBe((await admit('council', 'frozen')).callLimit + 1)
    expect((await admit('council', 'frozen', undefined, undefined, 'local')).host.webRules).toBe(
      undefined
    )
    // A provider may browse on its side, out of the app's sources: refused until PR 5 filters it.
    const viaOpenRouter = (spec: ReturnType<typeof workflowTemplate>) => {
      const read = reading(spec)
      return {
        ...read,
        steps: read.steps.map((step) =>
          step.id === 'rank'
            ? { ...step, agents: [...step.agents, { route: 'openrouter' as const, model: 'x/y' }] }
            : step
        )
      }
    }
    await expect(admit('council', 'frozen', viaOpenRouter, undefined, 'local')).rejects.toThrow(
      "Reading web pages isn't available with OpenRouter models yet."
    )
    // A workspace not proven to run here never reads pages from here.
    await expect(admit('council', 'frozen', reading)).rejects.toThrow(
      'Reading web pages needs a workspace that runs on this computer.'
    )
  })
})
