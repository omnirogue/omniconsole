import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Automation, AutomationRun } from '../../shared/automations-types'
import type { PersistedState } from '../../shared/persisted-state-types'
import { deliverRoutineRun, type RoutineDeliveryAdapters } from './routine-run-delivery'
import { RoutineRunDeliveryCoordinator } from './routine-run-delivery-coordinator'
import { writeAutomationDelivery } from '../persistence/scheduling-automations/automation-delivery-operations'
import { captureAutomationRunDefinition } from '../../shared/automation-run-definition'
const automation = {
  id: 'routine',
  name: 'Briefing',
  outputFormat: 'markdown',
  delivery: [{ kind: 'chat' }],
  notify: {
    onFinish: true,
    onlyWhenNotable: true,
    channels: [
      { kind: 'desktop' },
      { kind: 'slack-channel', channelId: 'C123', channelName: 'test' }
    ]
  }
} as Automation
const run = {
  id: 'run',
  deliveryVersion: 1,
  deliveryHostId: 'local',
  automationId: 'routine',
  status: 'completed',
  outputSnapshot: {
    content: 'Full report\n```routine-result\n{"notable":true,"summary":"One line"}\n```'
  }
} as AutomationRun
const adapters = (): RoutineDeliveryAdapters => ({
  desktop: vi.fn().mockResolvedValue(undefined),
  alert: vi.fn().mockResolvedValue({ permalink: 'https://slack.example/message' }),
  deliver: vi.fn().mockResolvedValue(undefined)
})
const paths: string[] = []
afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})
describe('routine delivery and alerts', () => {
  it('sends summary and deep link once, retaining the permalink', async () => {
    const api = adapters()
    const results = await deliverRoutineRun(automation, run, '', {
      phase: 'alerts',
      link: 'omni://automation/routine/run/run',
      adapters: api
    })
    expect(api.desktop).toHaveBeenCalledTimes(1)
    expect(api.alert).toHaveBeenCalledExactlyOnceWith(
      automation.notify!.channels[1],
      'One line',
      'omni://automation/routine/run/run',
      automation,
      run
    )
    expect(results[1]).toMatchObject({
      kind: 'slack-channel',
      target: 'C123',
      ok: true,
      permalink: 'https://slack.example/message'
    })
  })
  it('suppresses notable:false, and treats absent metadata as notable', async () => {
    const api = adapters()
    const quiet = {
      ...run,
      outputSnapshot: {
        ...run.outputSnapshot!,
        content: '```routine-result\n{"notable":false,"summary":"Quiet"}\n```'
      }
    }
    expect(
      await deliverRoutineRun(automation, quiet, '', { phase: 'alerts', link: '', adapters: api })
    ).toEqual([])
    expect(api.desktop).not.toHaveBeenCalled()
    await deliverRoutineRun(automation, { ...run, outputSnapshot: null }, '', {
      phase: 'alerts',
      link: '',
      adapters: api
    })
    expect(api.desktop).toHaveBeenCalledTimes(1)
  })
  it('claims durably before sending, coalesces concurrent completions and survives restart without replay', async () => {
    const state = { automations: [automation], automationRuns: [run] } as PersistedState
    const api = adapters()
    vi.mocked(api.alert).mockRejectedValue(new Error('Slack unavailable'))
    const flushed: string[] = []
    const authority = {
      read: async () => ({ automation: state.automations[0], run: state.automationRuns[0] }),
      write: (input: Parameters<typeof writeAutomationDelivery>[2]) =>
        writeAutomationDelivery(
          state,
          async () => {
            flushed.push(JSON.stringify(state))
          },
          input
        )
    }
    const coordinator = new RoutineRunDeliveryCoordinator(authority, 'alerts', '', api)
    await Promise.all([
      coordinator.deliver('routine', 'run'),
      coordinator.deliver('routine', 'run')
    ])
    expect(api.desktop).toHaveBeenCalledTimes(1)
    expect(api.alert).toHaveBeenCalledTimes(1)
    expect(JSON.parse(flushed[0]).automationRuns[0].deliveryClaims.alerts).toBeTruthy()
    expect(state.automationRuns[0]).toMatchObject({
      status: 'completed',
      deliveryResults: [{ ok: true }, { ok: false, error: 'Slack unavailable' }]
    })
    state.automationRuns = JSON.parse(JSON.stringify(state.automationRuns))
    await new RoutineRunDeliveryCoordinator(authority, 'alerts', '', api).deliver('routine', 'run')
    expect(api.desktop).toHaveBeenCalledTimes(1)
  })
  it('never sends when the durable claim cannot be written', async () => {
    const api = adapters()
    const state = { automations: [automation], automationRuns: [run] } as PersistedState
    const authority = {
      read: async () => ({ automation, run }),
      write: (input: Parameters<typeof writeAutomationDelivery>[2]) =>
        writeAutomationDelivery(
          state,
          async () => {
            throw new Error('disk full')
          },
          input
        )
    }
    await expect(
      new RoutineRunDeliveryCoordinator(authority, 'alerts', '', api).deliver('routine', 'run')
    ).rejects.toThrow('disk full')
    expect(api.desktop).not.toHaveBeenCalled()
  })
  it('never replays completed runs from before delivery support was installed', async () => {
    const api = adapters()
    const authority = {
      read: async () => ({ automation, run: { ...run, deliveryVersion: undefined } }),
      write: vi.fn()
    }
    await new RoutineRunDeliveryCoordinator(authority, 'alerts', '', api).deliver('routine', 'run')
    expect(authority.write).not.toHaveBeenCalled()
    expect(api.desktop).not.toHaveBeenCalled()
  })
  it('competing coordinators cannot both send or redirect a run after its definition changes', async () => {
    const changed: Automation = {
      ...automation,
      notify: { ...automation.notify!, channels: [{ kind: 'slack-dm' }] }
    }
    const captured: AutomationRun = { ...run, definitionSnapshot: automation }
    const state = {
      automations: [changed],
      automationRuns: [captured]
    } as PersistedState
    const api = adapters()
    const authority = {
      read: async () => ({ automation: state.automations[0], run: state.automationRuns[0] }),
      write: (input: Parameters<typeof writeAutomationDelivery>[2]) =>
        writeAutomationDelivery(state, async () => {}, input)
    }
    await Promise.all(
      [1, 2].map(() =>
        new RoutineRunDeliveryCoordinator(authority, 'alerts', '', api).deliver('routine', 'run')
      )
    )
    expect(api.desktop).toHaveBeenCalledTimes(1)
    expect(api.alert).toHaveBeenCalledTimes(1)
    expect(vi.mocked(api.alert).mock.calls[0][0]).toEqual(automation.notify!.channels[1])
  })
  it.each(['captured', 'empty'] as const)(
    'freezes defaults for an existing routine with a %s snapshot',
    async (mode) => {
      const oldDefinition = {
        ...automation,
        notify: undefined,
        delivery: undefined,
        outputFormat: undefined
      }
      const snapshot = mode === 'captured' ? captureAutomationRunDefinition(oldDefinition) : {}
      const changed = {
        ...automation,
        delivery: [{ kind: 'slack' as const, channel: 'NEW_CHANNEL' }]
      }
      const state = {
        automations: [changed],
        automationRuns: [{ ...run, definitionSnapshot: JSON.parse(JSON.stringify(snapshot)) }]
      } as PersistedState
      const api = adapters()
      const authority = {
        read: async () => ({ automation: changed, run: state.automationRuns[0] }),
        write: (input: Parameters<typeof writeAutomationDelivery>[2]) =>
          writeAutomationDelivery(state, async () => {}, input)
      }
      await new RoutineRunDeliveryCoordinator(authority, 'alerts', '', api).deliver(
        'routine',
        'run'
      )
      expect(api.desktop).toHaveBeenCalledTimes(1)
      expect(api.alert).not.toHaveBeenCalled()
      expect(api.deliver).not.toHaveBeenCalled()
      expect(state.automationRuns[0].deliveryResults).toEqual([
        { kind: 'desktop', target: 'desktop', ok: true }
      ])
    }
  )
  it('writes rendered file beside its output snapshot on the execution host', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'routine-delivery-'))
    paths.push(dir)
    const definition = { ...automation, delivery: [{ kind: 'file' as const, path: 'report.md' }] }
    expect(await deliverRoutineRun(definition, run, dir, { phase: 'execution', link: '' })).toEqual(
      [{ kind: 'file', target: 'report.md', ok: true }]
    )
    expect(await readFile(join(dir, 'report.md'), 'utf8')).toBe('Full report')
    expect(JSON.parse(await readFile(join(dir, 'outputSnapshot.json'), 'utf8'))).toEqual(
      run.outputSnapshot
    )
    const remote = {
      ...definition,
      executionTargetType: 'ssh' as const,
      schedulerOwner: 'ssh_bridge' as const
    }
    expect(
      (
        await deliverRoutineRun(remote, { ...run, deliveryHostId: 'ssh:remote' }, dir, {
          phase: 'execution',
          link: ''
        })
      )[0]
    ).toMatchObject({ ok: false })
  })
})
