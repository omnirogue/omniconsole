import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'vitest'

const script = fileURLToPath(new URL('./blind-quality-report.cjs', import.meta.url))
const manifestPath = fileURLToPath(
  new URL('../../../docs/workflows/quality-gate-small-2026-09-21.json', import.meta.url)
)
const manifestSha256 = createHash('sha256').update(readFileSync(manifestPath)).digest('hex')

function run(report, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'workflow-blind-'))
  const reportPath = join(directory, 'quality-report.json')
  writeFileSync(reportPath, JSON.stringify(report))
  const packetDir = options.packetDir ?? join(directory, 'packet')
  const mapFile = options.mapInPacket
    ? join(packetDir, 'map.json')
    : join(directory, 'private-map.json')
  const result = spawnSync(process.execPath, [script, reportPath, packetDir, mapFile], {
    encoding: 'utf8'
  })
  return { directory, packetDir, mapFile, reportPath, result }
}

function pairedOutputs(packetDir, mapFile) {
  const { armByLabel } = JSON.parse(readFileSync(mapFile, 'utf8'))
  return Object.fromEntries(
    Object.entries(armByLabel).map(([label, arm]) => [
      arm,
      readFileSync(join(packetDir, `${label}.txt`), 'utf8')
    ])
  )
}

describe('blind quality rater packets', () => {
  it('randomizes all three stable Council arms and omits answer keys and model metadata', () => {
    const output = run({
      caseId: 'council-01',
      preset: 'council',
      manifestSha256,
      sourceHead: 'test-head',
      finalOutcome: {
        state: 'completed',
        result: { synthesis: { markdown: 'Workflow decision' } }
      },
      baselines: {
        low: { value: { markdown: 'Low effort decision' } },
        high: { value: { markdown: 'High effort decision' } }
      }
    })
    assert.equal(output.result.status, 0)
    assert.deepEqual(readdirSync(output.packetDir).sort(), ['A.txt', 'B.txt', 'C.txt', 'case.md'])
    const map = JSON.parse(readFileSync(output.mapFile, 'utf8'))
    assert.deepEqual(Object.values(map.armByLabel).sort(), [
      'baseline-high',
      'baseline-low',
      'workflow'
    ])
    assert.deepEqual(pairedOutputs(output.packetDir, output.mapFile), {
      workflow: 'Workflow decision\n',
      'baseline-low': 'Low effort decision\n',
      'baseline-high': 'High effort decision\n'
    })
    const caseText = readFileSync(join(output.packetDir, 'case.md'), 'utf8')
    assert.ok(caseText.includes('Should we make the new incident triage rule'))
    assert.ok(caseText.includes('Score each axis 0'))
    assert.ok(!caseText.includes('Do not recommend default rollout'))
    assert.ok(!caseText.includes('claude-sonnet'))
    assert.notEqual(dirname(output.mapFile), output.packetDir)
  })

  it('preserves failed stable arms and ranked Discover findings for blind rating', () => {
    const output = run({
      caseId: 'discover-01',
      preset: 'discover',
      manifestSha256,
      finalOutcome: {
        state: 'completed',
        result: {
          survivors: [
            { id: 'second', title: 'Second', location: 'b', trigger: 'b', evidence: [] },
            { id: 'first', title: 'First', location: 'a', trigger: 'a', evidence: [] }
          ],
          ranking: { ranking: [{ findingId: 'first' }, { findingId: 'second' }] }
        }
      },
      baselines: { low: { value: null, error: 'timeout' }, high: { value: { findings: [] } } }
    })
    assert.equal(output.result.status, 0)
    const contents = pairedOutputs(output.packetDir, output.mapFile)
    assert.equal(contents['baseline-low'], 'NO OUTPUT (execution or parsing failed)\n')
    assert.equal(contents['baseline-high'], '[]\n')
    assert.ok(contents.workflow.indexOf('First') < contents.workflow.indexOf('Second'))
    assert.ok(!contents.workflow.includes('findingId'))
  })

  it('keeps the older two-arm report readable', () => {
    const output = run({
      caseId: 'council-01',
      preset: 'council',
      outcome: { state: 'completed', result: { synthesis: { markdown: 'Earlier workflow' } } },
      baseline: { value: { markdown: 'Earlier baseline' } }
    })
    assert.equal(output.result.status, 0)
    assert.deepEqual(readdirSync(output.packetDir).sort(), ['A.txt', 'B.txt', 'case.md'])
    assert.deepEqual(pairedOutputs(output.packetDir, output.mapFile), {
      workflow: 'Earlier workflow\n',
      baseline: 'Earlier baseline\n'
    })
  })

  it('refuses a stable report from a different frozen manifest', () => {
    const output = run({
      caseId: 'council-01',
      preset: 'council',
      manifestSha256: 'incorrect',
      finalOutcome: { state: 'completed', result: { synthesis: { markdown: 'A' } } },
      baselines: { low: { value: { markdown: 'B' } }, high: { value: { markdown: 'C' } } }
    })
    assert.notEqual(output.result.status, 0)
    assert.ok(output.result.stderr.includes('manifest hashes differ'))
    assert.deepEqual(readdirSync(output.directory).sort(), ['quality-report.json'])
  })

  it('refuses a map inside the packet and refuses to rerandomize an existing packet', () => {
    const report = {
      caseId: 'council-01',
      preset: 'council',
      outcome: { state: 'completed', result: { synthesis: { markdown: 'A' } } },
      baseline: { value: { markdown: 'B' } }
    }
    const first = run(report, { mapInPacket: true })
    assert.notEqual(first.result.status, 0)
    assert.ok(first.result.stderr.includes('outside the rater packet'))

    const second = run(report)
    assert.equal(second.result.status, 0)
    const mapBefore = readFileSync(second.mapFile, 'utf8')
    const retry = spawnSync(
      process.execPath,
      [script, second.reportPath, second.packetDir, second.mapFile],
      {
        encoding: 'utf8'
      }
    )
    assert.notEqual(retry.status, 0)
    assert.equal(readFileSync(second.mapFile, 'utf8'), mapBefore)
  })
})
