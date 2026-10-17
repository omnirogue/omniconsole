import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptyLaunchManifest, launchManifestReport } from '../shared/launch-manifest'
import { canonicalizeLaunchHostFlag, type LaunchHostNameDeps } from './launch-host-name'
import {
  canSupersedeLaunch,
  chooseLaunchOperation,
  launchIntentInputs,
  launchIntentKey,
  readLaunchIntent,
  resumeLaunchRecord,
  supersedeLaunchRecord,
  writeLaunchIntent
} from './session-launch-intent'
import {
  agentLaunchRecordStore,
  mintLaunchOperationId,
  type AgentLaunchRecord,
  type AgentLaunchRecordStore,
  type AgentLaunchSend
} from './session-launch-record'

const RUNTIME_A = '11111111-1111-4111-8111-111111111111'
const RUNTIME_B = '22222222-2222-4222-8222-222222222222'
let userData = ''
let store: AgentLaunchRecordStore

function record(overrides: Partial<AgentLaunchRecord> = {}): AgentLaunchRecord {
  const operationId = overrides.operationId ?? mintLaunchOperationId()
  return {
    v: 1,
    operationId,
    minted: true,
    intentKey: 'intent-a',
    createdAt: Date.now(),
    route: { kind: 'local' },
    executingRuntimeId: RUNTIME_A,
    hostId: 'local',
    hostLabel: 'this computer',
    request: {
      clientOperationId: operationId,
      worktree: 'id:repo::/work/app',
      agent: 'codex',
      prompt: 'Do the work.',
      sshAccountSelection: {
        policy: 'best-verified',
        expectedHostId: 'local',
        expectedRuntimeId: RUNTIME_A
      }
    },
    post: { done: false },
    sends: [],
    outcome: 'pending',
    summary: {
      host: {
        route: 'local',
        name: 'this computer',
        hostId: 'local',
        runtimeId: RUNTIME_A,
        appVersion: '1.12.19',
        why: 'where the workspace lives',
        alsoReachableAs: [],
        visibleIn: "this computer's sidebar"
      },
      workspace: { selector: 'id:repo::/work/app', hostId: 'local' },
      manifest: launchManifestReport(emptyLaunchManifest('Do the work.')),
      warnings: []
    },
    ...overrides
  }
}

function send(outcome: AgentLaunchSend['outcome']): AgentLaunchSend {
  return { at: Date.now(), outcome }
}

function choose(overrides: Partial<Parameters<typeof chooseLaunchOperation>[0]> = {}) {
  return chooseLaunchOperation({
    intentKey: 'intent-a',
    again: false,
    intentRecord: null,
    explicitRecord: null,
    ...overrides
  })
}

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'omni-launch-intent-'))
  store = agentLaunchRecordStore(userData)
})

afterEach(() => {
  rmSync(userData, { recursive: true, force: true })
})

describe('launch intents', () => {
  it('a second identical invocation follows the first operation instead of minting', () => {
    expect(choose()).toEqual({ kind: 'mint' })
    const first = record({ sends: [send('unverifiable')], outcome: 'unverifiable' })
    store.write(first)
    writeLaunchIntent(store, 'intent-a', first.operationId)
    const followed = store.read(readLaunchIntent(store, 'intent-a')!)
    expect(choose({ intentRecord: followed })).toEqual({ kind: 'follow', record: first })
    const created = record({ outcome: 'created' })
    expect(choose({ intentRecord: created })).toEqual({ kind: 'already-launched', record: created })
  })

  it('the intent key ignores title changes and changes with brief, worktree, cwd default, host, model or effort', () => {
    const base = new Map<string, string | boolean>([
      ['provider', 'codex'],
      ['prompt-file', 'brief.md'],
      ['title', 'First title']
    ])
    const key = (flags: Map<string, string | boolean>, cwd = '/work/app', prompt = 'Brief') =>
      launchIntentKey(launchIntentInputs(flags, cwd, prompt, {}))
    const original = key(base)
    const changed = (name: string, value: string) => key(new Map([...base, [name, value]]))
    expect(changed('title', 'Another title')).toBe(original)
    expect(changed('title-origin', 'generated')).toBe(original)
    expect(key(base, '/work/app', 'Another brief')).not.toBe(original)
    expect(key(base, '/work/other')).not.toBe(original)
    expect(changed('worktree', 'id:repo::/work/app')).not.toBe(original)
    // Why: an explicit worktree no longer depends on where the command runs.
    expect(key(new Map([...base, ['worktree', 'id:w']]), '/a')).toBe(
      key(new Map([...base, ['worktree', 'id:w']]), '/b')
    )
    expect(changed('host', 'runtime:env-1')).not.toBe(original)
    expect(changed('model', 'gpt-5.5')).not.toBe(original)
    expect(changed('effort', 'xhigh')).not.toBe(original)
    expect(changed('managed-tools-file', '/private/descriptor')).not.toBe(original)
  })

  it('the intent key uses --host as typed, so a re-run that resolves the name to the other route finds the same launch', async () => {
    const deps = (workspaceHostId: string | null): LaunchHostNameDeps => ({
      listEnvironments: async () => [{ id: 'env-2586', name: 'mw0002' }],
      listSshTargets: async () => [{ id: 'ssh-2586', label: 'mw0002' }],
      localWorkspaceHostId: async () => workspaceHostId,
      serverSelected: false
    })
    const keyFor = async (workspaceHostId: string | null) => {
      const flags = new Map<string, string | boolean>([
        ['provider', 'codex'],
        ['host', 'mw0002'],
        ['worktree', 'path:/srv/app']
      ])
      await canonicalizeLaunchHostFlag(flags, deps(workspaceHostId))
      return {
        host: flags.get('host'),
        key: launchIntentKey(launchIntentInputs(flags, '/a', 'B', {}))
      }
    }
    const viaSsh = await keyFor('ssh:ssh-2586')
    // Why: this computer's runtime restarting or not yet updated answers nothing.
    const paired = await keyFor(null)
    expect([viaSsh.host, paired.host]).toEqual(['ssh:ssh-2586', 'runtime:env-2586'])
    expect(paired.key).toBe(viaSsh.key)
  })

  it('--project joins the key without moving the keys of launches that do not use it', () => {
    const base = new Map<string, string | boolean>([
      ['provider', 'claude'],
      ['prompt-file', 'brief.md']
    ])
    const key = (flags: Map<string, string | boolean>, cwd = '/work/app') =>
      launchIntentKey(launchIntentInputs(flags, cwd, 'Brief', {}))
    // Why: a record written before --project existed must still be found by the same command.
    expect(key(base)).toBe(
      launchIntentKey({ ...launchIntentInputs(base, '/work/app', 'Brief', {}), project: null })
    )
    const project = new Map([...base, ['project', 'github:omnirogue/omni-ide']])
    expect(key(project)).not.toBe(key(base))
    expect(key(project)).not.toBe(
      key(new Map([...base, ['project', 'github:omnirogue/omnirogue']]))
    )
    // Placement never reads the cwd, `--host auto` only restates it, and --name is a label.
    expect(key(project, '/somewhere/else')).toBe(key(project))
    expect(key(new Map([...project, ['host', 'auto']]))).toBe(key(project))
    expect(key(new Map([...project, ['name', 'login-fix']]))).toBe(key(project))
    expect(key(new Map([...project, ['host', 'mw0002']]))).not.toBe(key(project))
    // Placement ignores ambient selectors, so a retry from a shell without them is the same launch.
    const ambient = (env: NodeJS.ProcessEnv) =>
      launchIntentKey(launchIntentInputs(project, '/work/app', 'Brief', env))
    expect(ambient({ ORCA_ENVIRONMENT: 'mw0002' })).toBe(key(project))
    expect(ambient({ ORCA_PAIRING_CODE: 'code' })).toBe(key(project))
    expect(
      launchIntentKey(
        launchIntentInputs(base, '/work/app', 'Brief', { ORCA_ENVIRONMENT: 'mw0002' })
      )
    ).not.toBe(key(base))
  })

  it('supersedes a record that has no request yet without inventing one', () => {
    const placing = record({ request: null })
    const { next } = supersedeLaunchRecord(placing, {
      operationId: mintLaunchOperationId(),
      runtimeId: RUNTIME_B,
      now: Date.now()
    })
    expect(next.request).toBeNull()
  })

  it('an explicit or intent-led superseded operation continues as its replacement, never a second supersede', () => {
    const replacement = record({ sends: [send(null)], outcome: 'unverifiable' })
    const superseded = record({
      sends: [send('not-started')],
      outcome: 'refused',
      supersededBy: replacement.operationId
    })
    const read = (operationId: string) =>
      operationId === replacement.operationId ? replacement : null
    const explicit = {
      explicitOperationId: superseded.operationId,
      explicitRecord: superseded,
      readRecord: read
    }
    expect(choose(explicit)).toEqual({ kind: 'follow', record: replacement })
    expect(choose({ intentRecord: superseded, readRecord: read })).toEqual({
      kind: 'follow',
      record: replacement
    })
    const created = { ...replacement, outcome: 'created' as const }
    expect(choose({ ...explicit, readRecord: () => created })).toEqual({
      kind: 'already-launched',
      record: created
    })
    // A replacement whose record is gone cannot be followed, so nothing is minted or resent.
    for (const readRecord of [() => null, undefined]) {
      expect(() => choose({ ...explicit, readRecord })).toThrow(
        expect.objectContaining({
          code: 'launch_outcome_unknown',
          message: expect.stringContaining('whose launch record is gone'),
          data: expect.objectContaining({
            operationId: superseded.operationId,
            outcome: 'unverifiable'
          })
        })
      )
    }
  })

  it('supersedes with a new ID and runtime only when every earlier send provably started nothing', () => {
    const notStarted = record({ sends: [send('not-started')], outcome: 'refused' })
    expect(resumeLaunchRecord(notStarted, RUNTIME_A)).toBe('resend')
    expect(resumeLaunchRecord(notStarted, RUNTIME_B)).toBe('supersede')
    const nextId = mintLaunchOperationId()
    const { old, next } = supersedeLaunchRecord(notStarted, {
      operationId: nextId,
      runtimeId: RUNTIME_B,
      now: Date.now()
    })
    expect(old.supersededBy).toBe(nextId)
    expect(next).toMatchObject({
      operationId: nextId,
      minted: true,
      executingRuntimeId: RUNTIME_B,
      supersedes: notStarted.operationId,
      sends: [],
      outcome: 'pending',
      request: {
        clientOperationId: nextId,
        prompt: 'Do the work.',
        sshAccountSelection: { expectedHostId: 'local', expectedRuntimeId: RUNTIME_B }
      }
    })
  })

  it('expired or runtime_changed after an unverifiable send refuses', () => {
    for (const sends of [
      [send('unverifiable'), send('not-started')],
      [send(null)],
      [send('replayed'), send('not-started')]
    ]) {
      const maybeStarted = record({ sends, outcome: 'refused' })
      expect(canSupersedeLaunch(maybeStarted)).toBe(false)
      expect(resumeLaunchRecord(maybeStarted, RUNTIME_B)).toBe('unverifiable')
    }
    const callerOwned = record({ minted: false, sends: [send('not-started')], outcome: 'refused' })
    expect(resumeLaunchRecord(callerOwned, RUNTIME_B)).toBe('unverifiable')
  })

  it('--again mints a new operation and repoints the intent', () => {
    const created = record({ outcome: 'created' })
    store.write(created)
    writeLaunchIntent(store, 'intent-a', created.operationId)
    expect(choose({ again: true, intentRecord: created })).toEqual({ kind: 'mint' })
    const again = mintLaunchOperationId()
    writeLaunchIntent(store, 'intent-a', again)
    expect(readLaunchIntent(store, 'intent-a')).toBe(again)
    expect(() =>
      choose({ again: true, explicitOperationId: created.operationId, explicitRecord: created })
    ).toThrow('--again starts a new operation')
  })

  it('an explicit --operation-id without a record requires --controller-runtime-id', () => {
    const operationId = mintLaunchOperationId()
    expect(() => choose({ explicitOperationId: operationId })).toThrow(
      `--operation-id ${operationId} has no launch record on this computer`
    )
    expect(choose({ explicitOperationId: operationId, explicitRuntimeId: RUNTIME_A })).toEqual({
      kind: 'explicit',
      operationId,
      runtimeId: RUNTIME_A
    })
    const elsewhere = record({ operationId, intentKey: 'intent-b' })
    expect(() => choose({ explicitOperationId: operationId, explicitRecord: elsewhere })).toThrow(
      'was recorded for a different launch'
    )
    const recorded = record({ operationId })
    expect(() =>
      choose({
        explicitOperationId: operationId,
        explicitRecord: recorded,
        explicitRuntimeId: RUNTIME_B
      })
    ).toThrow('was recorded for a different launch')
    expect(choose({ explicitOperationId: operationId, explicitRecord: recorded })).toEqual({
      kind: 'follow',
      record: recorded
    })
  })
})
