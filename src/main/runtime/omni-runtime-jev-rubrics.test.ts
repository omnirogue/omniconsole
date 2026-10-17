import { describe, expect, it, vi } from 'vitest'
import type { SavedReviewRubric } from '../../shared/review-rubrics'
import { JEV_RUBRICS_RUNTIME_CAPABILITY, RUNTIME_CAPABILITIES } from '../../shared/protocol-version'
import { OrcaRuntimeService } from './omni-runtime'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), isPackaged: false }
}))

function harness(initial: SavedReviewRubric[] = []) {
  let settings = { reviewRubrics: initial }
  const updateSettings = vi.fn((updates: Partial<typeof settings>) => {
    settings = { ...settings, ...updates }
  })
  const runtime = Object.create(OrcaRuntimeService.prototype) as OrcaRuntimeService
  Object.defineProperty(runtime, 'store', {
    value: {
      getSettings: () => settings,
      updateSettings
    }
  })
  return { runtime, updateSettings, settings: () => settings }
}

describe('runtime-owned reusable rubric mutation', () => {
  it('advertises the additive capability without changing protocol compatibility', () => {
    expect(RUNTIME_CAPABILITIES).toContain(JEV_RUBRICS_RUNTIME_CAPABILITY)
  })

  it('writes the same UI settings collection and notifies its existing listeners', () => {
    const other = { name: 'Existing', instructions: 'Keep this rubric' }
    const h = harness([other])
    const rubric = {
      name: 'Our research',
      instructions: '- Supported claims\n- Useful conclusions',
      kind: 'research' as const
    }
    const result = h.runtime.saveJevRubric(rubric)
    expect(result).toMatchObject({ value: 'saved:Our research', builtIn: false, kind: 'research' })
    expect(h.updateSettings).toHaveBeenCalledExactlyOnceWith(
      { reviewRubrics: [other, rubric] },
      { notifyListeners: true }
    )
    expect(h.runtime.getJevRubricLibrary().find((entry) => entry.value === result.value)).toEqual(
      result
    )
    expect(h.settings().reviewRubrics).toEqual([other, rubric])
  })

  it('reads current state for each save so concurrent agent requests preserve unrelated entries', () => {
    const h = harness()
    h.runtime.saveJevRubric({ name: 'First', instructions: 'First rubric' })
    h.runtime.saveJevRubric({ name: 'Second', instructions: 'Second rubric' })
    expect(h.settings().reviewRubrics.map((entry) => entry.name)).toEqual(['First', 'Second'])
    expect(() => h.runtime.saveJevRubric({ name: 'FIRST', instructions: 'Changed' })).toThrow(
      'replace'
    )
    expect(h.updateSettings).toHaveBeenCalledTimes(2)
    h.runtime.saveJevRubric({ name: 'FIRST', instructions: 'Changed' }, true)
    expect(h.settings().reviewRubrics.map((entry) => entry.name)).toEqual(['Second', 'FIRST'])
  })

  it('keeps libraries scoped to their selected runtime', () => {
    const left = harness()
    const right = harness()
    left.runtime.saveJevRubric({ name: 'Only here', instructions: 'Own host rubric' })
    expect(
      left.runtime.getJevRubricLibrary().some((entry) => entry.value === 'saved:Only here')
    ).toBe(true)
    expect(
      right.runtime.getJevRubricLibrary().some((entry) => entry.value === 'saved:Only here')
    ).toBe(false)
    expect(right.updateSettings).not.toHaveBeenCalled()
  })
})
