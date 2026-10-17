import { describe, expect, it } from 'vitest'
import { assertScanReplaySupported, graphFindRules } from './graph-plan-types'
import { workflowSetFind } from '../../../../shared/workflow-graph-find'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import type { WorkflowRoute } from '../../../../shared/workflow-graph'

const ROUTES: WorkflowRoute[] = ['claude', 'codex']

describe('graphFindRules', () => {
  it('reads host.findRules defensively, absent on older snapshots', () => {
    expect(graphFindRules({ host: { findRules: 3 } })).toEqual({ findRules: 3 })
    expect(graphFindRules({ host: {} })).toEqual({})
    expect(graphFindRules({})).toEqual({})
  })
})

describe('assertScanReplaySupported', () => {
  it('refuses a run carrying Scan structured items (itemDetails) admitted under rules < 4', () => {
    const spec = workflowSetFind(
      workflowTemplate('find', ROUTES),
      { items: [{ title: 'Acme', detail: 'a vendor' }] },
      ROUTES
    )
    expect(spec.find?.itemDetails).toBeDefined()
    expect(() => assertScanReplaySupported(spec, { host: { findRules: 3 } })).toThrow(
      "This run was made by a development build of Scan and can't be resumed; start it again."
    )
    expect(() => assertScanReplaySupported(spec, {})).toThrow(
      "This run was made by a development build of Scan and can't be resumed; start it again."
    )
  })

  it('refuses a run carrying an import receipt admitted under rules < 4', () => {
    const spec = workflowSetFind(
      workflowTemplate('find', ROUTES),
      {
        items: ['Alpha', 'Beta'],
        importReceipt: { read: 2, imported: 2, skipped: [], merged: 0 }
      },
      ROUTES
    )
    expect(spec.find?.importReceipt).toBeDefined()
    expect(() => assertScanReplaySupported(spec, { host: { findRules: 3 } })).toThrow(
      /development build of Scan/
    )
  })

  it('never refuses the same structured run once admitted at rules 4 or later', () => {
    const spec = workflowSetFind(
      workflowTemplate('find', ROUTES),
      { items: [{ title: 'Acme', detail: 'a vendor' }] },
      ROUTES
    )
    expect(() => assertScanReplaySupported(spec, { host: { findRules: 4 } })).not.toThrow()
  })

  it('a pre-Scan run (plain string items, rules 2/3 or absent) replays byte-identically: never refused', () => {
    const spec = workflowSetFind(
      workflowTemplate('find', ROUTES),
      { items: ['Alpha', 'Beta'] },
      ROUTES
    )
    expect(spec.find?.itemDetails).toBeUndefined()
    expect(spec.find?.importReceipt).toBeUndefined()
    expect(() => assertScanReplaySupported(spec, { host: { findRules: 2 } })).not.toThrow()
    expect(() => assertScanReplaySupported(spec, { host: { findRules: 3 } })).not.toThrow()
    expect(() => assertScanReplaySupported(spec, {})).not.toThrow()
  })
})
