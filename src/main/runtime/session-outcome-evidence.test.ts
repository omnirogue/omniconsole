import type { OrcaRuntimeService } from './omni-runtime'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifySessionOutcomeCondition } from './session-outcome-evidence'
import { sessionOutcomeCandidateVersion } from './session-outcome-candidate'

const dirs: string[] = []
async function folder() {
  const dir = await mkdtemp(join(tmpdir(), 'outcome-proof-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('execution-host evidence from real files/processes', () => {
  it('checks the file requirement as well as its presence, including seven to fourteen days', async () => {
    const dir = await folder()
    await writeFile(join(dir, 'report.json'), JSON.stringify({ days: 7 }))
    await writeFile(
      join(dir, 'verify.cjs'),
      "const report = require('./report.json'); console.log('days=' + report.days)"
    )
    const condition = {
      id: 'report',
      kind: 'file' as const,
      target: 'report.json',
      verification: { program: process.execPath, args: ['verify.cjs'], expectedStdout: 'days=14' }
    }
    expect(await verifySessionOutcomeCondition(condition, dir)).toMatchObject({ verified: false })
    await writeFile(join(dir, 'report.json'), JSON.stringify({ days: 14 }))
    expect(await verifySessionOutcomeCondition(condition, dir)).toMatchObject({ verified: true })
  })

  it('refuses file evidence if its verifier changes the delivered bytes', async () => {
    const dir = await folder()
    await writeFile(join(dir, 'report.json'), JSON.stringify({ days: 7 }))
    await writeFile(
      join(dir, 'verify.cjs'),
      "require('node:fs').writeFileSync('report.json', '{}'); console.log('checked')"
    )
    expect(
      await verifySessionOutcomeCondition(
        {
          id: 'report',
          kind: 'file',
          target: 'report.json',
          verification: {
            program: process.execPath,
            args: ['verify.cjs'],
            expectedStdout: 'checked'
          }
        },
        dir
      )
    ).toMatchObject({ verified: false, reason: expect.stringContaining('changed') })
  })

  it('does not accept HTTP 200 or a merged review as deployed functional proof', async () => {
    const dir = await folder()
    await writeFile(join(dir, 'verify.cjs'), "console.log('HTTP 200; PR merged')")
    expect(
      await verifySessionOutcomeCondition(
        {
          id: 'release',
          kind: 'deployment',
          target: 'fixture installation',
          version: 'build123',
          verification: {
            program: process.execPath,
            args: ['verify.cjs'],
            expectedStdout: 'installed=build123; functional-check=pass'
          }
        },
        dir
      )
    ).toMatchObject({ verified: false })
  })
  it('verifies actual delivered bytes and rejects a stale pinned version', async () => {
    const dir = await folder(),
      path = join(dir, 'report.md')
    await writeFile(path, 'requested report')
    const version = createHash('sha256').update('requested report').digest('hex')
    const condition = { id: 'report', kind: 'file' as const, target: path, version }
    expect(await verifySessionOutcomeCondition(condition, dir)).toMatchObject({
      verified: true,
      version
    })
    await writeFile(path, 'a later revision')
    expect(await verifySessionOutcomeCondition(condition, dir)).toMatchObject({ verified: false })
  })
  it('records a hash for a newly produced file whose bytes were unknown when committed', async () => {
    const dir = await folder(),
      path = join(dir, 'new.txt')
    const condition = { id: 'file', kind: 'file' as const, target: path }
    expect(await verifySessionOutcomeCondition(condition, dir)).toMatchObject({ verified: false })
    await writeFile(path, 'new deliverable')
    expect(await verifySessionOutcomeCondition(condition, dir)).toMatchObject({
      verified: true,
      receipt: expect.stringContaining('sha256:')
    })
  })
  it('runs the committed verification program and checks its exit and output predicate', async () => {
    const dir = await folder()
    await writeFile(join(dir, 'installed.txt'), 'installed=build123')
    await writeFile(
      join(dir, 'verify.cjs'),
      "process.stdout.write(require('node:fs').readFileSync('installed.txt', 'utf8'))"
    )
    const condition = {
      id: 'release',
      kind: 'deployment' as const,
      target: 'test installation',
      version: 'build123',
      verification: {
        program: process.execPath,
        args: ['verify.cjs'],
        expectedStdout: 'installed=build123'
      }
    }
    expect(await verifySessionOutcomeCondition(condition, dir)).toMatchObject({
      verified: true,
      version: 'build123'
    })
    expect(
      await verifySessionOutcomeCondition(
        { ...condition, verification: { ...condition.verification, expectedStdout: 'build456' } },
        dir
      )
    ).toMatchObject({ verified: false })
    expect(
      await verifySessionOutcomeCondition(
        {
          ...condition,
          verification: { ...condition.verification, args: ['-e', 'process.exit(1)'] }
        },
        dir
      )
    ).toMatchObject({ verified: false })
  })
  it('never turns a missing integration or requested human review into success', async () => {
    const dir = await folder()
    for (const kind of ['review', 'handoff', 'pr', 'merge', 'deployment'] as const) {
      expect(
        await verifySessionOutcomeCondition({ id: kind, kind, target: 'target' }, dir)
      ).toMatchObject({ verified: false })
    }
  })
  it('uses content for folder review rounds, so unchanged repairs keep the same candidate', async () => {
    const dir = await folder(),
      path = join(dir, 'draft.txt')
    await writeFile(path, 'draft 1')
    const first = await sessionOutcomeCandidateVersion(dir, ['draft.txt'])
    expect(await sessionOutcomeCandidateVersion(dir, ['draft.txt'])).toBe(first)
    await writeFile(path, 'draft 2')
    expect(await sessionOutcomeCandidateVersion(dir, ['draft.txt'])).not.toBe(first)
  })
})

it('requires the actual provider review request to target the committed branch', async () => {
  const { verifySessionOutcomeExternalCondition } =
    await import('./session-outcome-external-evidence')
  const { vi } = await import('vitest')
  const getRepoPRForBranch = vi.fn().mockResolvedValue({
    kind: 'found',
    pr: {
      number: 12,
      url: 'https://gitlab.example/org/repo/merge_requests/12',
      state: 'merged',
      headSha: 'head',
      baseRefName: 'wrong'
    }
  })
  const runtime = { getRepoPRForBranch } as unknown as OrcaRuntimeService
  const condition = {
    id: 'merge',
    kind: 'merge' as const,
    target: 'https://gitlab.example/org/repo/merge_requests/12',
    repository: 'repo',
    branch: 'working',
    targetBranch: 'release',
    version: 'head'
  }
  await expect(verifySessionOutcomeExternalCondition(condition, runtime)).resolves.toMatchObject({
    verified: false
  })
  getRepoPRForBranch.mockResolvedValue({
    kind: 'found',
    pr: {
      number: 12,
      url: condition.target,
      state: 'merged',
      headSha: 'head',
      baseRefName: 'release'
    }
  })
  await expect(verifySessionOutcomeExternalCondition(condition, runtime)).resolves.toMatchObject({
    verified: true
  })
  expect(getRepoPRForBranch).toHaveBeenCalledWith('repo', 'working', 12, 12, true, 'head', 'manual')
})
