import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type Database from '../../sqlite/sync-database'
import type { WorkflowCheckpointStore } from './workflow-checkpoint-store'
import type { DiscoverOmniosFinding } from '../../../shared/discover-omnios-page'
import { projectLocalWorkflow, readLocalWorkflowExecution } from './local-workflow-projection'
import { workflowRunResult } from '../../../shared/workflow-run-result'
import {
  discoverFocusedPrompt,
  readDiscoverFocusFinding,
  withoutDiscoverFocus
} from './discover-focus-finding'

vi.mock('./local-workflow-projection', () => ({
  projectLocalWorkflow: vi.fn(),
  readLocalWorkflowExecution: vi.fn()
}))
vi.mock('../../../shared/workflow-run-result', () => ({ workflowRunResult: vi.fn() }))
const db = {} as Database.Database
function parent(workspaceId = 'workspace') {
  vi.mocked(readLocalWorkflowExecution).mockReturnValue({
    state: 'completed',
    fence: 1
  } as ReturnType<typeof readLocalWorkflowExecution>)
  vi.mocked(workflowRunResult).mockReturnValue({
    template: 'discover',
    state: 'completed',
    markdown: '',
    gaps: [],
    calls: [],
    timing: { wallClockMs: 0 },
    results: {
      targets: ['first raw', 'ranked first'].map((title, index) => ({
        key: `k${index}`,
        title,
        location: `src/${index}.ts:1`,
        severity: 'high',
        tally: 'confirmed',
        detail: `Evidence for ${title}`,
        votes: [],
        repeats: 0
      })),
      ranking: [{ key: 'k1', rank: 1, why: 'High impact', next: 'Recheck evidence' }]
    }
  } as unknown as ReturnType<typeof workflowRunResult>)
  return {
    inspect: () => ({
      snapshot: {
        host: { workspaceId, conversationId: 'c' },
        task: { prompt: 'Improve this' },
        graph: { spec: { template: 'discover' } }
      }
    })
  } as unknown as WorkflowCheckpointStore
}

describe('Dig deeper focus', () => {
  it('uses the saved page number when a newer ranking would order findings differently', () => {
    const root = mkdtempSync(join(tmpdir(), 'discover-focus-'))
    try {
      mkdirSync(join(root, 'run'))
      const store = parent()
      const finding = readDiscoverFocusFinding(db, store, 'run:1', 'workspace')
      const file = join(root, 'run', 'findings.json')
      writeFileSync(file, JSON.stringify({ findings: [{ ...finding, title: 'Published first' }] }))
      expect(readDiscoverFocusFinding(db, store, 'run:1', 'workspace', root).title).toBe(
        'Published first'
      )
      writeFileSync(file, '{broken')
      expect(() => readDiscoverFocusFinding(db, store, 'run:1', 'workspace', root)).toThrow(
        /saved page/
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('resolves the page number by ranking, and seeds the brief with its evidence', () => {
    const finding = readDiscoverFocusFinding(db, parent(), 'run:1', 'workspace')
    expect(finding.title).toBe('ranked first')
    expect(finding.location).toBe('src/1.ts:1')
    expect(discoverFocusedPrompt('Check this', finding)).toContain('Evidence for ranked first')
    expect(discoverFocusedPrompt('Check this', finding)).toContain('Next: Recheck evidence')
    expect(projectLocalWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ executionId: 'run', active: false })
    )
  })
  it('removes only the focused title, leaving other earlier findings available', () => {
    const finding = readDiscoverFocusFinding(db, parent(), 'run:1', 'workspace')
    const earlier = {
      step: 'find',
      runs: ['run'],
      titles: ['ranked first (src/1.ts:1)', 'another title (src/2.ts:1)']
    }
    expect(withoutDiscoverFocus(earlier, finding).titles).toEqual(['another title (src/2.ts:1)'])
    expect(earlier.titles).toHaveLength(2)
    expect(withoutDiscoverFocus(earlier, undefined)).toBe(earlier)
    const long = { ...finding, title: 'x'.repeat(310) } as DiscoverOmniosFinding
    expect(
      withoutDiscoverFocus({ ...earlier, titles: [`${'x'.repeat(299)}…`] }, long).titles
    ).toEqual([])
  })
  it('refuses a different workspace, unfinished run, absent page number and malformed reference', () => {
    expect(() => readDiscoverFocusFinding(db, parent('other'), 'run:1', 'workspace')).toThrow(
      /this workspace/
    )
    const store = parent()
    vi.mocked(readLocalWorkflowExecution).mockReturnValue({
      state: 'running',
      fence: 1
    } as ReturnType<typeof readLocalWorkflowExecution>)
    expect(() => readDiscoverFocusFinding(db, store, 'run:1', 'workspace')).toThrow(/completed/)
    expect(() => readDiscoverFocusFinding(db, parent(), 'run:8', 'workspace')).toThrow(/no finding/)
    expect(() => readDiscoverFocusFinding(db, parent(), '../run:1', 'workspace')).toThrow(/must be/)
  })
})
