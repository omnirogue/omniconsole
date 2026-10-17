// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogModel } from '../../../shared/agent-session-option-catalog'
import {
  CLAUDE_SESSION_OPTION_CATALOG,
  CODEX_SESSION_OPTION_CATALOG
} from '../../../shared/agent-session-option-catalog-claude-codex'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from '../../../shared/native-chat-session-options'
import { buildNativeChatSessionOptionSnapshot } from '../../../shared/native-chat-session-option-snapshot'
import { createNativeChatSessionOptionRecord } from '../../../shared/native-chat-session-option-state'

type UsableEntry = { id: string; status: 'usable'; models: CatalogModel[]; modelsProbed: boolean }

const capabilities = vi.hoisted(() => ({
  usable: [] as UsableEntry[],
  refresh: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({ tabsByWorktree: { wt1: [{ id: 'tab-1' }] } })
}))
vi.mock('./useWorkAgentCapabilities', () => ({
  useWorkAgentCapabilities: () => ({ usable: capabilities.usable, refresh: capabilities.refresh })
}))

import { useWorkSessionOptions } from './useWorkSessionOptions'

function codexSnapshot(): SessionOptionDescriptor[] {
  const record = createNativeChatSessionOptionRecord('codex')
  record.model = { value: 'gpt-5.5', source: 'reported' }
  return buildNativeChatSessionOptionSnapshot({
    catalog: CODEX_SESSION_OPTION_CATALOG,
    models: CODEX_SESSION_OPTION_CATALOG.models,
    record,
    mode: 'live',
    modelLabel: 'Model'
  })
}

function probedCodex(levels: string[]): CatalogModel {
  return {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    options: [
      {
        id: 'effort',
        label: 'Reasoning effort',
        category: 'thought_level',
        kind: {
          type: 'select',
          choices: levels.map((value) => ({ value, label: value })),
          defaultValue: 'medium'
        },
        apply: {}
      }
    ]
  }
}

function surfaceFor(snapshot: SessionOptionDescriptor[]): SessionOptionsSurface & {
  setOption: ReturnType<typeof vi.fn>
} {
  return {
    getSnapshot: () => snapshot,
    setOption: vi.fn().mockResolvedValue({ snapshot }),
    invokeAction: vi.fn().mockResolvedValue({ snapshot }),
    subscribe: () => () => {}
  }
}

function effortChoices(snapshot: SessionOptionDescriptor[]): string[] | null {
  const effort = snapshot.find((descriptor) => descriptor.id === 'effort')
  return effort?.kind.type === 'select' ? effort.kind.choices.map((choice) => choice.value) : null
}

function setUsable(entries: UsableEntry[]): void {
  capabilities.usable = entries
  capabilities.refresh.mockResolvedValue(entries)
}

const STATIC_CODEX_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh']

describe('useWorkSessionOptions', () => {
  beforeEach(() => {
    capabilities.refresh.mockReset()
    setUsable([])
  })

  it('intersects Codex effort choices with the probed levels', () => {
    setUsable([
      {
        id: 'codex',
        status: 'usable',
        models: [probedCodex(['low', 'medium', 'high'])],
        modelsProbed: true
      }
    ])
    const { result } = renderHook(() =>
      useWorkSessionOptions({
        agent: 'codex',
        tabId: 'tab-1',
        surface: surfaceFor(codexSnapshot()),
        snapshot: codexSnapshot(),
        transport: 'catalog'
      })
    )
    expect(effortChoices(result.current.snapshot)).toEqual(['low', 'medium', 'high'])
  })

  it('falls back to the static catalog for terminal-backed Codex when it is usable but unprobed', async () => {
    setUsable([{ id: 'codex', status: 'usable', models: [], modelsProbed: false }])
    const snapshot = codexSnapshot()
    const original = surfaceFor(snapshot)
    const { result } = renderHook(() =>
      useWorkSessionOptions({
        agent: 'codex',
        tabId: 'tab-1',
        surface: original,
        snapshot,
        transport: 'catalog'
      })
    )
    expect(result.current.snapshot).toBe(snapshot)
    expect(effortChoices(result.current.snapshot)).toEqual(STATIC_CODEX_EFFORTS)

    await result.current.surface!.setOption('effort', 'xhigh')
    expect(original.setOption).toHaveBeenCalledWith('effort', 'xhigh')
  })

  it('offers nothing and refuses every set when Codex is not a usable agent', async () => {
    // Not installed, disabled, or without a seat: `usable` has no Codex entry at
    // all, which is not the same as "usable but the probe has not answered".
    setUsable([])
    const snapshot = codexSnapshot()
    const original = surfaceFor(snapshot)
    const { result } = renderHook(() =>
      useWorkSessionOptions({
        agent: 'codex',
        tabId: 'tab-1',
        surface: original,
        snapshot,
        transport: 'catalog'
      })
    )
    expect(effortChoices(result.current.snapshot)).toBeNull()
    expect(result.current.snapshot.find((descriptor) => descriptor.id === 'model')).toMatchObject({
      settable: false,
      kind: { choices: [] }
    })
    await expect(result.current.surface!.setOption('effort', 'xhigh')).rejects.toThrow(
      'This setting is no longer available.'
    )
    expect(original.setOption).not.toHaveBeenCalled()
  })

  it.each(['codex', 'claude', 'grok', 'omp'])(
    'uses the live %s session options even when launch discovery is unavailable',
    async (agent) => {
      const snapshot = codexSnapshot()
      const original = surfaceFor(snapshot)
      const { result } = renderHook(() =>
        useWorkSessionOptions({ agent, tabId: 'tab-1', surface: original, snapshot })
      )
      expect(result.current.snapshot).toBe(snapshot)
      await result.current.surface!.setOption('model', 'gpt-5.5')
      expect(original.setOption).toHaveBeenCalledWith('model', 'gpt-5.5')
      await expect(result.current.surface!.setOption('model', 'missing')).rejects.toThrow(
        'This setting is no longer available.'
      )
      expect(original.setOption).toHaveBeenCalledTimes(1)
      expect(capabilities.refresh).not.toHaveBeenCalled()
    }
  )

  it('keeps the empty-choice behaviour for other agents', async () => {
    const record = createNativeChatSessionOptionRecord('claude')
    record.model = { value: 'opus', source: 'reported' }
    const snapshot = buildNativeChatSessionOptionSnapshot({
      catalog: CLAUDE_SESSION_OPTION_CATALOG,
      models: CLAUDE_SESSION_OPTION_CATALOG.models,
      record,
      mode: 'live',
      modelLabel: 'Model'
    })
    const original = surfaceFor(snapshot)
    const { result } = renderHook(() =>
      useWorkSessionOptions({
        agent: 'claude',
        tabId: 'tab-1',
        surface: original,
        snapshot,
        transport: 'catalog'
      })
    )
    expect(effortChoices(result.current.snapshot)).toBeNull()
    expect(result.current.snapshot.find((descriptor) => descriptor.id === 'model')).toMatchObject({
      settable: false,
      kind: { choices: [] }
    })
    await expect(result.current.surface!.setOption('model', 'opus')).rejects.toThrow(
      'This setting is no longer available.'
    )
  })
})
