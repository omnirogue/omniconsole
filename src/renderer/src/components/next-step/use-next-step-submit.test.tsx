// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  emptyNextStepDraft,
  type NextStepActor,
  type NextStepDraft
} from '../../../../shared/next-step-draft'
import { useNextStepSubmit } from './use-next-step-submit'
import type { NextStepAvailableAgent } from './use-next-step-recipients'

vi.mock('@/i18n/i18n', () => ({ translate: (key: string) => key }))
vi.mock('./next-step-send', () => ({ createNextStepSendMemory: () => ({}), sendNextStep: vi.fn() }))
vi.mock('../../../../shared/next-step-compile', () => ({
  compileNextStepChain: () => ({ problems: [] })
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))
afterEach(cleanup)
const primary = 'x-ai/grok-4.5'
const fallback = 'google/gemini-2.5-pro'
const actor: NextStepActor = {
  agent: 'omp',
  model: `openrouter/${primary}`,
  openrouterCandidates: [primary, fallback]
}
function available(hosts = ['selected']): NextStepAvailableAgent[] {
  return [
    {
      id: 'omp',
      label: 'OMP',
      cmd: 'omp',
      homepageUrl: 'https://example.com',
      status: 'usable',
      models: [primary, fallback].map((model) => ({
        id: `openrouter/${model}`,
        label: model,
        options: [],
        hosts
      }))
    }
  ]
}
function draft(selected = actor): NextStepDraft {
  return {
    ...emptyNextStepDraft(),
    recipients: [
      {
        ...selected,
        kind: 'agent',
        key: 'actor',
        presetId: 'implement',
        instructions: 'Work',
        rounds: 1
      }
    ]
  }
}
function submit(selected: NextStepDraft, fresh = available(), fleet = true) {
  const onSubmit = vi.fn().mockResolvedValue(undefined)
  const refreshAgents = vi.fn().mockResolvedValue(fresh)
  const hook = renderHook(() =>
    useNextStepSubmit({
      subject: { kind: 'card', item: { task_id: 'task', title: 'Exact source' } } as never,
      draft: selected,
      refreshAgents,
      fleet,
      fleetMachineId: 'selected',
      cardlessHandoffs: false,
      onSubmit
    })
  )
  return { hook, onSubmit, refreshAgents }
}

describe('fallback admission at send time', () => {
  it('rechecks the exact host after editing and refuses a candidate that moved to a sibling host', async () => {
    const fresh = available()
    fresh[0]!.models[1]!.hosts = ['sibling']
    const selected = draft()
    const original = structuredClone(selected)
    const { hook, onSubmit, refreshAgents } = submit(selected, fresh)
    await act(() => hook.result.current.send())
    expect(refreshAgents).toHaveBeenCalledOnce()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(hook.result.current.error).toBe('nextStep.fleetFallback.candidatesUnavailable')
    expect(selected).toEqual(original)
  })
  it('passes the exact reviewed order through to dispatch without mutating the persisted draft', async () => {
    const selected = draft()
    const { hook, onSubmit } = submit(selected)
    await act(() => hook.result.current.send())
    expect(onSubmit).toHaveBeenCalledWith(selected)
    const sent = onSubmit.mock.calls[0]![0] as NextStepDraft
    expect(sent).not.toBe(selected)
    expect(sent.recipients[0]).toMatchObject({ openrouterCandidates: [primary, fallback] })
  })
  it('keeps fixed-only requests omitted and never invents a primary OMP model', async () => {
    const fixed = submit(draft({ agent: 'omp', model: actor.model }))
    await act(() => fixed.hook.result.current.send())
    expect(fixed.onSubmit.mock.calls[0]![0].recipients[0]).not.toHaveProperty(
      'openrouterCandidates'
    )
    const unset = submit(draft({ agent: 'omp' }))
    await act(() => unset.hook.result.current.send())
    expect(unset.onSubmit).not.toHaveBeenCalled()
    expect(unset.hook.result.current.error).toBe('nextStep.fleetFallback.primaryUnavailable')
  })
  it('refuses saved local and follow-on fallback routes instead of dropping them', async () => {
    const local = submit(draft(), available(), false)
    await act(() => local.hook.result.current.send())
    expect(local.onSubmit).not.toHaveBeenCalled()
    expect(local.hook.result.current.error).toBe('nextStep.localFallback.unavailable')
    const selected = draft({ agent: 'omp', model: actor.model })
    selected.after = [
      {
        kind: 'agent',
        key: 'next',
        actor: { ...actor, model: `openrouter/${fallback}` },
        presetId: 'review',
        instructions: 'Review',
        rounds: 1
      }
    ]
    const follow = submit(selected)
    await act(() => follow.hook.result.current.send())
    expect(follow.onSubmit).not.toHaveBeenCalled()
    expect(follow.hook.result.current.error).toBe('nextStep.fleetFallback.invalidOrder')
  })
})

it('admits a local route only while every model has fresh execution-host routing evidence', async () => {
  const fresh = available()
  fresh[0]!.models.forEach((model) => {
    model.openrouterRouting = 'omp-openrouter-routing-v1'
  })
  const requested = draft()
  const local = submit(requested, fresh, false)
  await act(() => local.hook.result.current.send())
  expect(local.onSubmit).toHaveBeenCalledWith(requested)
  delete fresh[0]!.models[1]!.openrouterRouting
  const revoked = submit(draft(), fresh, false)
  await act(() => revoked.hook.result.current.send())
  expect(revoked.onSubmit).not.toHaveBeenCalled()
  expect(revoked.hook.result.current.error).toBe('nextStep.localFallback.missing')
})
