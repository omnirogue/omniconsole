import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { auditFixtureSnapshot } from '../../../../../config/scripts/workflows/probe-audit-pipeline'
import { createWorkflowProgramContext } from '../workflow-program-context'
import { EARLIER_RUNS_LABEL } from '../workflow-earlier-findings'
import { findAuditNovelty } from './audit-read'
import { validateAuditSnapshot, type AuditSnapshot } from './audit-snapshot'

const directory = mkdtempSync(join(tmpdir(), 'audit-earlier-findings-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const fixture = auditFixtureSnapshot(directory)
const audit = fixture.audit!

function context() {
  return createWorkflowProgramContext({
    agent: async () => {
      throw new Error('Unexpected agent call')
    },
    phase: () => {},
    log: () => {},
    guard: () => {},
    isFatal: () => false
  })
}

async function noveltyCalls(earlierFindings?: AuditSnapshot['earlierFindings']) {
  const calls: { id: string; instruction: string; data: Record<string, unknown> }[] = []
  const ask = async (id: string, instruction: string, _seat: string, data: { lens?: string }) => {
    calls.push({ id, instruction, data })
    return id.startsWith('novelty/')
      ? { version: 1, lens: data.lens, existingFindingIds: [], findings: [] }
      : { version: 1, findings: [] }
  }
  await findAuditNovelty(
    context(),
    ask as never,
    { ...audit, ...(earlierFindings ? { earlierFindings } : {}) },
    [],
    []
  )
  return calls
}

describe('Audit earlier-run titles', () => {
  it('shows the titles to the novelty readers only', async () => {
    const plain = await noveltyCalls()
    const seeded = await noveltyCalls({ runs: ['run-1'], titles: ['Repeated manual export'] })
    const readers = plain.filter(({ id }) => id.startsWith('novelty/'))
    expect(readers.length).toBeGreaterThan(0)
    for (const call of readers) {
      expect(Object.keys(call.data)).toEqual(['lens', 'chunks', 'existing'])
      expect(call.instruction).not.toContain(EARLIER_RUNS_LABEL)
    }
    seeded.forEach((call, index) => {
      if (!call.id.startsWith('novelty/')) {
        expect(call).toEqual(plain[index])
        return
      }
      expect(call.data).toEqual({ ...plain[index].data, earlierRuns: ['Repeated manual export'] })
      expect(call.instruction).toBe(
        `${plain[index].instruction} ${EARLIER_RUNS_LABEL}: the titles in earlierRuns.`
      )
    })
    // An empty list asks exactly as before.
    expect(await noveltyCalls({ runs: [], titles: [] })).toEqual(plain)
  })

  it('accepts at most fifty short titles', () => {
    const titles = (count: number, length = 20) =>
      Array.from({ length: count }, (_, i) => `${i}`.padEnd(length, 'x'))
    const check = (list: string[]) =>
      validateAuditSnapshot(
        { ...audit, earlierFindings: { runs: ['r'], titles: list } },
        fixture.seats
      )
    expect(() => check(titles(50, 300))).not.toThrow()
    expect(() => check(titles(51))).toThrow('Earlier audit titles must be at most 50 short lines')
    expect(() => check(titles(1, 301))).toThrow(
      'Earlier audit titles must be at most 50 short lines'
    )
  })
})
