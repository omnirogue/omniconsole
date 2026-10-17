import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import type { AutomationOwnerRef } from '../../../../../shared/automation-owner-ref'
import type { Automation } from '../../../../../shared/automations-types'
import type { AutomationHostTarget } from '../../automations/automation-host-client'
import { makeAutomation, makeRun } from '../../automations/automations-page-fixtures'
import { readStructuredRoutineConversation } from './structured-routine-conversation'

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn(),
  getRuntimeEnvironmentStatus: vi.fn()
}))

const local = { kind: 'local' } as const
const remote = { kind: 'environment', environmentId: 'remote-1' } as const
const classification = { provider: 'typesafe', contract: 'classification.v1' } as const
const advertising = {
  provider: 'typesafe',
  contract: 'advertising.v1',
  advertising: { company: 'omnirogue', accountId: 'act_12345' }
} as const
const automation = makeAutomation({ structuredOutput: classification })
const run = makeRun()
const rpc = vi.mocked(callRuntimeRpc)
const owners: { name: string; sourceTarget: AutomationHostTarget; owner: AutomationOwnerRef }[] = [
  local,
  remote
].flatMap((sourceTarget) =>
  [{ kind: 'self' as const }, { kind: 'ssh' as const, targetId: 'ssh-1', targetGeneration: 9 }].map(
    (selector) => ({
      name: `${sourceTarget.kind}/${selector.kind}`,
      sourceTarget,
      owner: {
        authority:
          sourceTarget.kind === 'local'
            ? { kind: 'desktop' as const }
            : { kind: 'runtime' as const, environmentId: 'remote-1', pairingRevision: 4 },
        selector
      }
    })
  )
)

function options(signal: AbortSignal, owner: AutomationOwnerRef) {
  return {
    signal,
    timeoutMs: 15_000,
    ...(owner.authority.kind === 'runtime'
      ? { expectedEnvironmentPairingRevision: owner.authority.pairingRevision }
      : {})
  }
}

function mockShow(response: unknown) {
  rpc.mockResolvedValueOnce(response).mockResolvedValueOnce({ runs: [run] })
}

beforeEach(() => {
  rpc.mockReset()
  replaceRuntimeEnvironmentRevisions([{ id: 'remote-1', createdAt: 1, pairingRevision: 4 }])
})

afterEach(() => replaceRuntimeEnvironmentRevisions([]))

describe('readStructuredRoutineConversation', () => {
  it.each(owners)(
    'captures the authoritative $name owner before reading history',
    async (entry) => {
      const signal = new AbortController().signal
      mockShow({ automation, owner: { selector: entry.owner.selector } })

      await expect(
        readStructuredRoutineConversation(automation, entry.sourceTarget, signal)
      ).resolves.toEqual({ runs: [run], ownerRef: entry.owner, sourceTarget: entry.sourceTarget })
      expect(rpc).toHaveBeenNthCalledWith(
        1,
        entry.sourceTarget,
        'automation.show',
        { id: automation.id },
        options(signal, entry.owner)
      )
      expect(rpc).toHaveBeenNthCalledWith(
        2,
        entry.sourceTarget,
        'automation.runs',
        { automationId: automation.id, expectedOwner: { selector: entry.owner.selector } },
        options(signal, entry.owner)
      )
      expect(rpc).toHaveBeenCalledTimes(2)
    }
  )

  it.each(owners)(
    'uses an explicit $name capture without rediscovering ownership',
    async (entry) => {
      const signal = new AbortController().signal
      replaceRuntimeEnvironmentRevisions([{ id: 'remote-1', createdAt: 1, pairingRevision: 99 }])
      rpc.mockResolvedValueOnce({ runs: [run] })

      await expect(
        readStructuredRoutineConversation(automation, entry.sourceTarget, signal, entry.owner)
      ).resolves.toEqual({ runs: [run], ownerRef: entry.owner, sourceTarget: entry.sourceTarget })
      expect(rpc).toHaveBeenCalledTimes(1)
      expect(rpc).toHaveBeenCalledWith(
        entry.sourceTarget,
        'automation.runs',
        { automationId: automation.id, expectedOwner: { selector: entry.owner.selector } },
        options(signal, entry.owner)
      )
    }
  )

  it('pins history to the revision captured before ownership discovery', async () => {
    rpc
      .mockImplementationOnce(async () => {
        replaceRuntimeEnvironmentRevisions([{ id: 'remote-1', createdAt: 1, pairingRevision: 5 }])
        return { automation, owner: { selector: { kind: 'self' } } }
      })
      .mockResolvedValueOnce({ runs: [run] })

    const result = await readStructuredRoutineConversation(
      automation,
      remote,
      new AbortController().signal
    )

    expect(result.ownerRef.authority).toEqual({
      kind: 'runtime',
      environmentId: 'remote-1',
      pairingRevision: 4
    })
    expect(rpc.mock.calls.map((call) => call[3]?.expectedEnvironmentPairingRevision)).toEqual([
      4, 4
    ])
  })

  it.each([local, remote])('returns the resolved authority for source %j', async (sourceTarget) => {
    const contextual = makeAutomation({
      structuredOutput: classification,
      runContext: {
        kind: 'workspace-run',
        projectId: 'project-1',
        hostId: 'runtime:context-host',
        projectHostSetupId: 'setup-1',
        repoId: 'repo-1',
        path: '/srv/omni'
      }
    })
    replaceRuntimeEnvironmentRevisions([
      { id: 'remote-1', createdAt: 1, pairingRevision: 4 },
      { id: 'context-host', createdAt: 2, pairingRevision: 8 }
    ])
    mockShow({ automation: contextual, owner: { selector: { kind: 'self' } } })

    const result = await readStructuredRoutineConversation(
      contextual,
      sourceTarget,
      new AbortController().signal
    )

    const expected =
      sourceTarget.kind === 'local'
        ? { kind: 'environment', environmentId: 'context-host' }
        : remote
    expect(result.sourceTarget).toEqual(expected)
    expect(rpc.mock.calls.map((call) => call[0])).toEqual([expected, expected])
  })

  it('accepts equivalent advertising defaults and reordered source properties', async () => {
    const requested = makeAutomation({ structuredOutput: advertising })
    mockShow({
      automation: {
        ...requested,
        structuredOutput: {
          advertising: {
            maxEvidenceAgeSeconds: 300,
            accountId: 'act_12345',
            minConfidence: 0.8,
            company: 'omnirogue'
          },
          contract: 'advertising.v1',
          provider: 'typesafe'
        }
      },
      owner: { selector: { kind: 'self' } }
    })

    await expect(
      readStructuredRoutineConversation(requested, local, new AbortController().signal)
    ).resolves.toMatchObject({ runs: [run] })
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it.each<{ name: string; changes: Partial<Automation> }>([
    { name: 'another routine', changes: { id: 'a-2' } },
    { name: 'changed prompt', changes: { prompt: 'A different decision' } },
    { name: 'changed execution target type', changes: { executionTargetType: 'ssh' } },
    { name: 'changed execution target', changes: { executionTargetId: 'ssh-2' } },
    { name: 'changed execution target generation', changes: { executionTargetGeneration: 10 } },
    { name: 'changed contract', changes: { structuredOutput: advertising } },
    { name: 'missing configuration', changes: { structuredOutput: undefined } }
  ])('refuses $name before reading history', async ({ changes }) => {
    mockShow({ automation: { ...automation, ...changes }, owner: { selector: { kind: 'self' } } })

    await expect(
      readStructuredRoutineConversation(automation, local, new AbortController().signal)
    ).rejects.toThrow()
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('accepts timestamp advancement when the routine settings are unchanged', async () => {
    mockShow({
      automation: { ...automation, updatedAt: automation.updatedAt + 1 },
      owner: { selector: { kind: 'self' } }
    })

    await expect(
      readStructuredRoutineConversation(automation, local, new AbortController().signal)
    ).resolves.toMatchObject({ runs: [run] })
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it.each([
    { company: 'betacorp' },
    { accountId: 'act_67890' },
    { minConfidence: 0.9 },
    { maxEvidenceAgeSeconds: 600 }
  ])('refuses changed advertising policy %j', async (changes) => {
    const requested = makeAutomation({ structuredOutput: advertising })
    mockShow({
      automation: {
        ...requested,
        structuredOutput: {
          ...advertising,
          advertising: { ...advertising.advertising, ...changes }
        }
      },
      owner: { selector: { kind: 'self' } }
    })

    await expect(
      readStructuredRoutineConversation(requested, local, new AbortController().signal)
    ).rejects.toThrow()
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['missing owner', undefined],
    ['orphan', { selector: { kind: 'orphan' } }],
    ['unknown selector', { selector: { kind: 'local' } }],
    ['missing SSH generation', { selector: { kind: 'ssh', targetId: 'ssh-1' } }],
    ['empty SSH target', { selector: { kind: 'ssh', targetId: '', targetGeneration: 9 } }]
  ])('refuses %s without guessing an owner from the routine', async (_name, owner) => {
    mockShow({ automation, owner })

    await expect(
      readStructuredRoutineConversation(automation, local, new AbortController().signal)
    ).rejects.toThrow()
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it.each([undefined, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses unavailable or invalid runtime revision %s before any request',
    async (revision) => {
      replaceRuntimeEnvironmentRevisions(
        revision === undefined ? [] : [{ id: 'remote-1', createdAt: 1, pairingRevision: revision }]
      )

      await expect(
        readStructuredRoutineConversation(automation, remote, new AbortController().signal)
      ).rejects.toThrow()
      expect(rpc).not.toHaveBeenCalled()
    }
  )

  it.each([
    { sourceTarget: local, owner: owners[2].owner },
    { sourceTarget: remote, owner: owners[0].owner },
    {
      sourceTarget: remote,
      owner: {
        authority: { kind: 'runtime' as const, environmentId: 'another-host', pairingRevision: 4 },
        selector: { kind: 'self' as const }
      }
    }
  ])('refuses an explicit owner from another authority %#', async ({ sourceTarget, owner }) => {
    await expect(
      readStructuredRoutineConversation(
        automation,
        sourceTarget,
        new AbortController().signal,
        owner
      )
    ).rejects.toThrow()
    expect(rpc).not.toHaveBeenCalled()
  })

  it('does not read history after ownership discovery is cancelled', async () => {
    const controller = new AbortController()
    rpc.mockImplementationOnce(async () => {
      controller.abort()
      return { automation, owner: { selector: { kind: 'self' } } }
    })

    await expect(
      readStructuredRoutineConversation(automation, local, controller.signal)
    ).rejects.toThrow()
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['missing history', {}],
    ['invalid history', { runs: null }],
    ['invalid run', { runs: [null] }],
    ['missing run ID', { runs: [{ ...run, id: undefined }] }],
    ['missing run title', { runs: [{ ...run, title: undefined }] }],
    ['invalid run timestamp', { runs: [{ ...run, createdAt: Number.NaN }] }],
    ['another routine', { runs: [run, makeRun({ id: 'run-2', automationId: 'a-2' })] }]
  ])('rejects %s in the history response', async (_name, response) => {
    rpc.mockResolvedValueOnce(response)

    await expect(
      readStructuredRoutineConversation(
        automation,
        local,
        new AbortController().signal,
        owners[0].owner
      )
    ).rejects.toThrow()
    expect(rpc).toHaveBeenCalledTimes(1)
  })
})
