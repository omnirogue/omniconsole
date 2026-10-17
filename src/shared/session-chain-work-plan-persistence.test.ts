import { describe, expect, it } from 'vitest'
import {
  SESSION_CHAIN_SCHEMA_VERSION,
  normalizeSessionChain,
  normalizeSessionChains,
  normalizeSessionChainsWithReport,
  type SessionChain,
  type SessionChainAgentStep
} from './session-chain-types'
import {
  SESSION_CHAIN_RUN_LIFECYCLE_SCHEMA_VERSION,
  SESSION_CHAIN_LAUNCH_RECEIPT_SCHEMA_VERSION
} from './session-chain-normalize'
import { usesRunLifecycleFields } from './session-chain-quarantine'
import { sessionVerdictFailRoute } from './session-chain-verdict-receipts'
import { openHumanAttention } from './session-human-attention'
import { reviseSessionOutcomeSet } from './session-outcome-state'
import type { SessionOutcomeAttempt, SessionOutcomeSet } from './session-outcome-types'
import { sealSessionRunCompletion } from './session-run-completion'

const outcomeSet = (stepIds: string[]) =>
  reviseSessionOutcomeSet(
    undefined,
    {
      expectedRevision: 0,
      source: 'user',
      outcomes: [
        {
          id: 'plan',
          title: 'Plan the webinar',
          finish: 'complete',
          outputKind: 'plan',
          dependsOn: [],
          stepIds,
          actions: [],
          conditions: [
            {
              id: 'plan_file',
              kind: 'file',
              target: 'plan.json',
              fileVersions: [{ path: 'plan.json', schema: 'work-plan-v1' }]
            }
          ]
        }
      ]
    },
    { owner: 'execution-host', hostId: 'local', epoch: 'epoch', state: 'owned' },
    1
  )

/** Every field the work plan adds, on one chain, exactly as it is written to disk. */
const workPlanChain = () => ({
  id: 'chn_plan',
  workspacePath: '/Users/me/Webinar',
  worktreeId: 'folder:f1',
  hostId: 'local',
  sourcePaneKey: 'tab-1:leaf-1',
  sourceRowKey: '["local","folder:f1","tab-1:leaf-1"]',
  auto: true,
  steps: [
    {
      id: 's1',
      agent: 'claude',
      prompt: 'research the offer',
      group: 'g1',
      seat: { index: 1, total: 2 },
      planNodeId: 'node_research',
      route: 'new-session',
      writes: 'own-output-dir',
      wait: { reason: 'capacity', since: 1700 },
      status: 'queued'
    },
    {
      id: 's2',
      agent: 'claude',
      prompt: 'research the audience',
      group: 'g1',
      seat: { index: 2, total: 2 },
      planNodeId: 'node_research',
      readsFrom: ['s1'],
      status: 'queued'
    },
    {
      id: 's3',
      agent: 'claude',
      prompt: 'pick the winner',
      verdict: { kind: 'judge', over: ['s1', 's2'], consumed: 'select-winner' },
      enabledBy: { verdict: 'v_research', seatsOf: 'node_research' },
      readsWinnerOf: 'node_research',
      route: 'same-session',
      writes: 'workspace',
      // WP-2 lowers a gate's fail route onto its seat; a reload that dropped it would leave a
      // failing gate blocking where the plan said "route to the repair".
      onFail: 's4',
      status: 'queued'
    },
    {
      id: 's4',
      agent: 'claude',
      prompt: 'repair what the gate found',
      planNodeId: 'node_repair',
      status: 'queued'
    }
  ],
  outcomeSet: outcomeSet(['s1', 's2', 's3', 's4']),
  verdicts: [
    {
      stepId: 's3',
      attemptId: 'att_1',
      verdict: { status: 'pass', winner: 's2' },
      consumptionKey: 'node_research:judge:1',
      consumedAt: 1800
    },
    {
      stepId: 's2',
      attemptId: 'att_2',
      verdict: { status: 'skipped' },
      consumptionKey: 'node_research:judge:2',
      consumedAt: 1801,
      skipped: true as const
    }
  ],
  currentIndex: 1,
  state: 'waiting',
  schemaVersion: SESSION_CHAIN_SCHEMA_VERSION,
  createdAt: 1,
  updatedAt: 2
})

const legacyChain = () => ({
  id: 'chn_old',
  workspacePath: '/w',
  worktreeId: 'folder:f1',
  hostId: 'local',
  sourcePaneKey: 'tab-1:leaf-1',
  sourceRowKey: 'row',
  auto: false,
  steps: [{ id: 's1', agent: 'claude', prompt: 'go', status: 'queued' }],
  currentIndex: 0,
  state: 'waiting',
  createdAt: 1,
  updatedAt: 2
})

describe('work-plan fields survive persistence', () => {
  it('carries every step field and the chain verdicts through the normalizer unchanged', () => {
    const persisted = workPlanChain()
    const loaded = normalizeSessionChain(persisted)
    expect(loaded).toEqual(persisted)
    // Why spelled out: a round trip that lost the same field on both sides would still deep-equal.
    expect(loaded?.steps[0]).toMatchObject({
      seat: { index: 1, total: 2 },
      planNodeId: 'node_research',
      route: 'new-session',
      writes: 'own-output-dir',
      wait: { reason: 'capacity', since: 1700 }
    })
    expect(loaded?.steps[1]).toMatchObject({ readsFrom: ['s1'], seat: { index: 2, total: 2 } })
    expect(loaded?.steps[2]).toMatchObject({
      verdict: { kind: 'judge', over: ['s1', 's2'], consumed: 'select-winner' },
      enabledBy: { verdict: 'v_research', seatsOf: 'node_research' },
      readsWinnerOf: 'node_research'
    })
    expect(loaded?.steps[2]).toMatchObject({ onFail: 's4' })
    // The one reader of the field agrees with the disk, which is what routes a failed gate.
    expect(sessionVerdictFailRoute(loaded!.steps[2] as SessionChainAgentStep)).toBe('s4')
    expect(loaded?.verdicts).toHaveLength(2)
    expect(loaded?.verdicts?.[1]?.skipped).toBe(true)
    // A second pass changes nothing: what the host saves every tick is what it read.
    expect(normalizeSessionChain(loaded)).toEqual(loaded)
  })

  it('stamps the schema version only on a chain that uses the fields that version added', () => {
    const persisted = legacyChain()
    const loaded = normalizeSessionChain(persisted)
    expect(JSON.stringify(loaded)).toBe(JSON.stringify(persisted))
    expect(loaded?.schemaVersion).toBeUndefined()
    const planned = normalizeSessionChain({
      ...persisted,
      steps: [{ ...persisted.steps[0], planNodeId: 'node_1' }]
    })
    expect(planned?.schemaVersion).toBe(SESSION_CHAIN_SCHEMA_VERSION)
    // A fail route is as much a version-2 record as a seat: an older host must quarantine the
    // chain rather than run it without the branch the person authored.
    const routed = normalizeSessionChain({
      ...persisted,
      steps: [{ ...persisted.steps[0], onFail: 's2' }]
    })
    expect(routed?.steps[0]).toMatchObject({ onFail: 's2' })
    expect(routed?.schemaVersion).toBe(SESSION_CHAIN_SCHEMA_VERSION)
    // So is the composer's own record: which stage a seat belongs to, and the prompts the
    // person added to that stage. A host that dropped either would run a plan they did not
    // compose, so the chain is stamped and an older build quarantines it.
    const staged = normalizeSessionChain({
      ...persisted,
      steps: [{ ...persisted.steps[0], stage: { id: 'stage-1', shape: 'council', width: 3 } }]
    })
    expect(staged?.steps[0]).toMatchObject({ stage: { shape: 'council', width: 3 } })
    expect(staged?.schemaVersion).toBe(SESSION_CHAIN_SCHEMA_VERSION)
    const prompted = normalizeSessionChain({
      ...persisted,
      steps: [
        {
          ...persisted.steps[0],
          prompts: [{ id: 'p1', text: 'Check every Done When.', createdAt: 1, state: 'queued' }]
        }
      ]
    })
    expect(prompted?.steps[0]).toMatchObject({ prompts: [{ id: 'p1', state: 'queued' }] })
    expect(prompted?.schemaVersion).toBe(SESSION_CHAIN_SCHEMA_VERSION)
    // And a legacy chain that carries neither is still loaded, unstamped, byte for byte.
    expect(normalizeSessionChain(persisted)?.schemaVersion).toBeUndefined()
  })

  it('refuses a field it cannot read instead of deleting it, and names the step', () => {
    const broken = {
      ...legacyChain(),
      steps: [{ ...legacyChain().steps[0], wait: { reason: 'thinking', since: 1 } }]
    }
    expect(normalizeSessionChain(broken)).toBeNull()
    const report = normalizeSessionChainsWithReport([broken])
    expect(report.unloadable).toEqual([
      { id: 'chn_old', reason: 'invalid-step', detail: 'step s1: this build cannot read wait' }
    ])
    expect(report.chains[0]?.quarantine?.record).toEqual(broken)
  })

  it('refuses the whole chain when a committed outcome names a step it cannot read', () => {
    const lost = {
      ...workPlanChain(),
      steps: [workPlanChain().steps[0], { ...workPlanChain().steps[1], agent: 'not-an-agent' }]
    }
    expect(normalizeSessionChain(lost)).toBeNull()
    const missing = { ...workPlanChain(), steps: [workPlanChain().steps[0]] }
    const report = normalizeSessionChainsWithReport([missing])
    expect(report.chains[0]?.steps).toEqual([])
    expect(report.chains[0]?.outcomeSet).toBeUndefined()
    expect(report.unloadable[0]).toMatchObject({ id: 'chn_plan', reason: 'invalid-step' })
    expect(report.unloadable[0]?.detail).toContain('s2')
  })

  it('keeps a record written by a newer build untouched instead of dropping it', () => {
    // The newest record this build reads includes the durable tab receipt; anything past it is refused.
    const newer = {
      ...workPlanChain(),
      schemaVersion: SESSION_CHAIN_LAUNCH_RECEIPT_SCHEMA_VERSION + 1
    }
    const report = normalizeSessionChainsWithReport([newer])
    expect(report.unloadable[0]).toMatchObject({ id: 'chn_plan', reason: 'newer-schema' })
    expect(report.chains).toHaveLength(1)
    expect(report.chains[0]?.quarantine?.record).toEqual(newer)
    expect(report.chains[0]?.state).toBe('failed')
    // The quarantined record survives being read and written again, unchanged and still reported.
    const again = normalizeSessionChainsWithReport([report.chains[0]])
    expect(again.chains[0]).toEqual(report.chains[0])
    expect(again.unloadable[0]).toMatchObject({ reason: 'newer-schema' })
  })

  it('refuses committed outcomes it cannot read and unwraps them once it can', () => {
    const fromTheFuture = {
      ...workPlanChain(),
      outcomeSet: { ...workPlanChain().outcomeSet, unknownField: true }
    }
    const report = normalizeSessionChainsWithReport([fromTheFuture])
    expect(report.unloadable[0]).toMatchObject({ id: 'chn_plan', reason: 'invalid-outcome-set' })
    const kept = report.chains[0] as SessionChain
    expect(kept.quarantine?.record).toEqual(fromTheFuture)
    // A build that understands the record again loads it from the quarantine instead of the husk.
    const repaired = normalizeSessionChains([
      { ...kept, quarantine: { ...kept.quarantine!, record: workPlanChain() } }
    ])
    expect(repaired[0]).toEqual(normalizeSessionChain(workPlanChain()))
    expect(repaired[0]?.quarantine).toBeUndefined()
  })

  it('reports nothing and loads everything for chains this build can read', () => {
    const report = normalizeSessionChainsWithReport([workPlanChain(), legacyChain()])
    expect(report.unloadable).toEqual([])
    expect(report.chains.map((chain) => chain.id)).toEqual(['chn_plan', 'chn_old'])
  })
})

describe('run-lifecycle records survive persistence', () => {
  const attempt = (extra: Partial<SessionOutcomeAttempt>): SessionOutcomeAttempt => ({
    id: 'att_1',
    outcomeId: 'plan',
    actionId: 'step_s1',
    actionKey: 'step_s1',
    outcomeRevision: 1,
    state: 'running',
    startedAt: 3,
    updatedAt: 4,
    ...extra
  })
  const base = (): SessionOutcomeSet => outcomeSet(['s1', 's2', 's3', 's4'])
  /** An agent asked its person a question: a request, the block that names it, and the asking attempt. */
  const asked = (): SessionOutcomeSet => {
    const set = base()
    const opened = openHumanAttention(
      {
        ...set,
        attempts: [
          attempt({
            awaiting: { kind: 'clarification', prompt: 'Which offer leads?', since: 4 }
          }),
          attempt({
            id: 'att_0',
            state: 'retryable',
            failure: { code: 'startup-blocked', detail: 'codex-hooks-review-prompt', at: 2 }
          })
        ]
      },
      {
        kind: 'clarification',
        scope: { outcomeId: 'plan', outcomeRevision: 1, stepId: 's1', attemptId: 'att_1' },
        ask: "Answer Claude's question: Which offer leads?",
        why: 'Claude cannot choose this for you and is waiting for your answer.',
        recipient: { type: 'owner' },
        action: { kind: 'open-conversation', label: 'Answer', paneKey: 'tab-1:leaf-1' },
        source: { type: 'agent-prompt', ref: 'Which offer leads?' }
      },
      5
    )
    return {
      ...opened.set,
      outcomes: [
        {
          ...opened.set.outcomes[0]!,
          status: 'blocked',
          blockedReason: 'Claude is asking a question.',
          block: { class: 'attention', code: 'agent-question', since: 5, attentionIds: [opened.id] }
        }
      ]
    }
  }
  const sealed = (): SessionOutcomeSet =>
    sealSessionRunCompletion(
      { ...base(), sessionFinish: { action: 'save', folderId: 'folder_1' } },
      { now: 9, operationId: 'op_seal', planVersion: 1 }
    )

  it('carries requests, block classes, failure codes and awaiting prompts through unchanged', () => {
    const persisted = { ...workPlanChain(), outcomeSet: asked() }
    const loaded = normalizeSessionChain(persisted)
    expect(loaded).toEqual({
      ...persisted,
      schemaVersion: SESSION_CHAIN_RUN_LIFECYCLE_SCHEMA_VERSION
    })
    // Why spelled out: a round trip that lost the same field on both sides would still deep-equal.
    expect(loaded?.outcomeSet?.attention).toHaveLength(1)
    expect(loaded?.outcomeSet?.outcomes[0]?.block).toMatchObject({
      class: 'attention',
      attentionIds: [loaded?.outcomeSet?.attention?.[0]?.id]
    })
    expect(loaded?.outcomeSet?.attempts[0]?.awaiting?.prompt).toBe('Which offer leads?')
    expect(loaded?.outcomeSet?.attempts[1]?.failure).toEqual({
      code: 'startup-blocked',
      detail: 'codex-hooks-review-prompt',
      at: 2
    })
    // What the host saves every tick is what it read, through a real JSON round trip too.
    expect(normalizeSessionChain(JSON.parse(JSON.stringify(loaded)))).toEqual(loaded)
  })

  it('never drops the seal or the disposition, however often the chain is read and written', () => {
    const persisted = { ...workPlanChain(), state: 'done', outcomeSet: sealed() }
    const loaded = normalizeSessionChain(JSON.parse(JSON.stringify(persisted)))
    expect(loaded?.schemaVersion).toBe(SESSION_CHAIN_RUN_LIFECYCLE_SCHEMA_VERSION)
    expect(loaded?.outcomeSet?.completion).toEqual({
      at: 9,
      outcomes: [{ id: 'plan', revision: 1 }],
      planVersion: 1,
      evidenceIds: []
    })
    expect(loaded?.outcomeSet?.disposition).toEqual({
      intent: 'save',
      folderId: 'folder_1',
      state: 'pending',
      operationId: 'op_seal',
      attempts: 0,
      updatedAt: 9
    })
    expect(normalizeSessionChain(loaded)).toEqual(loaded)
  })

  it('stamps the run-lifecycle version on exactly the chains that carry such a record', () => {
    expect(usesRunLifecycleFields(undefined)).toBe(false)
    expect(usesRunLifecycleFields(base())).toBe(false)
    expect(normalizeSessionChain(workPlanChain())?.schemaVersion).toBe(SESSION_CHAIN_SCHEMA_VERSION)
    const blocked = asked()
    const { attention: _attention, ...noRequests } = blocked
    const carriers: SessionOutcomeSet[] = [
      sealed(),
      { ...base(), attention: [] },
      { ...noRequests, attempts: [] },
      { ...base(), attempts: [blocked.attempts[0]!] },
      { ...base(), attempts: [blocked.attempts[1]!] }
    ]
    for (const carried of carriers) {
      expect(usesRunLifecycleFields(carried)).toBe(true)
      expect(
        normalizeSessionChain({ ...workPlanChain(), outcomeSet: carried })?.schemaVersion
      ).toBe(SESSION_CHAIN_RUN_LIFECYCLE_SCHEMA_VERSION)
    }
  })

  it('is refused as newer-schema by a build that predates it, instead of being half-read', () => {
    const loaded = normalizeSessionChain({ ...workPlanChain(), outcomeSet: sealed() })!
    // An older build refuses any version above its own before it looks at a single field; that
    // build's own version is SESSION_CHAIN_SCHEMA_VERSION.
    expect(loaded.schemaVersion).toBeGreaterThan(SESSION_CHAIN_SCHEMA_VERSION)
    // The same rule in this build, one version on: refused, kept verbatim, and never rewritten.
    const future = { ...loaded, schemaVersion: SESSION_CHAIN_LAUNCH_RECEIPT_SCHEMA_VERSION + 1 }
    const report = normalizeSessionChainsWithReport([future])
    expect(report.unloadable[0]).toMatchObject({ id: 'chn_plan', reason: 'newer-schema' })
    expect(report.chains[0]?.quarantine?.record).toEqual(future)
    expect(report.chains[0]?.outcomeSet).toBeUndefined()
    // A record already stamped with this version loads, and keeps the stamp.
    expect(normalizeSessionChain(JSON.parse(JSON.stringify(loaded)))).toEqual(loaded)
  })

  it('preserves a launched tab receipt and fences older readers from relaunching it', () => {
    const persisted = {
      ...legacyChain(),
      steps: [
        {
          ...legacyChain().steps[0],
          status: 'launched' as const,
          launchedTabId: 'tab_launch'
        }
      ]
    }
    const loaded = normalizeSessionChain(persisted)
    expect(loaded?.steps[0]).toMatchObject({ status: 'launched', launchedTabId: 'tab_launch' })
    expect(loaded?.schemaVersion).toBe(SESSION_CHAIN_LAUNCH_RECEIPT_SCHEMA_VERSION)
  })
})
