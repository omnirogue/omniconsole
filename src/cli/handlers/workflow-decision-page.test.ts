import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { WORKFLOW_DECISION_PAGE_HANDLERS } from './workflow-decision-page'
import type { HandlerContext } from '../dispatch'
import { discoverOmniosRun } from '../../shared/discover-omnios-page'
import type { WorkflowRunResult } from '../../shared/workflow-run-result'

const folders: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const f of folders.splice(0)) {
    await rm(f, { recursive: true, force: true })
  }
})

it('rebuilds both pages from edited fields with stable keys and escaped evidence', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'discover-page-'))
  folders.push(folder)
  const targets = Array.from({ length: 10 }, (_, i) => ({
    key: `k${i}`,
    title: `Title ${i}`,
    tally: 'confirmed',
    votes: [],
    repeats: 0,
    detail: '<evidence>',
    location: '',
    round: 1,
    step: 'verify'
  }))
  const run = discoverOmniosRun(
    {
      results: { targets, ranking: [] },
      calls: [],
      timing: {},
      gaps: [],
      template: 'discover'
    } as unknown as WorkflowRunResult,
    { goal: 'Improve', workspace: 'folder' }
  )
  await writeFile(join(folder, 'findings.json'), JSON.stringify(run))
  const ctx = {
    cwd: folder,
    flags: new Map([['file', 'findings.json']]),
    json: true
  } as HandlerContext
  vi.spyOn(console, 'log').mockImplementation(() => {})
  await WORKFLOW_DECISION_PAGE_HANDLERS['workflow render-page'](ctx)
  const before = await readFile(join(folder, 'page-2.html'), 'utf8')
  expect(before).toContain('data-key="9. Title 8"')
  expect(before).toContain('&lt;evidence&gt;')
  run.findings[8].why = 'Updated <why>'
  await writeFile(join(folder, 'findings.json'), JSON.stringify(run))
  await WORKFLOW_DECISION_PAGE_HANDLERS['workflow render-page'](ctx)
  const after = await readFile(join(folder, 'page-2.html'), 'utf8')
  expect(after).toContain('Updated &lt;why&gt;')
  expect(after).toContain('data-key="9. Title 8"')
})
