import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionFollowUpRule } from '../../shared/session-follow-up-rule'
import { gitExecFileAsync } from '../git/runner'
import { materializeSessionOutcomeGitDeliverables } from './session-outcome-git-deliverables'

const roots: string[] = []

async function repository() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'outcome-delivery-')))
  roots.push(parent)
  const workspacePath = join(parent, 'repo')
  const destinationRoot = join(parent, 'chosen')
  await mkdir(join(workspacePath, 'deliverables'), { recursive: true })
  await mkdir(destinationRoot)
  await gitExecFileAsync(['init', workspacePath], { cwd: parent })
  await gitExecFileAsync(['config', 'user.name', 'Delivery test'], { cwd: workspacePath })
  await gitExecFileAsync(['config', 'user.email', 'delivery@example.invalid'], {
    cwd: workspacePath
  })
  await writeFile(join(workspacePath, 'deliverables', 'inventory-report.md'), 'accepted report\n')
  await gitExecFileAsync(['add', '.'], { cwd: workspacePath })
  await gitExecFileAsync(['commit', '-m', 'candidate'], { cwd: workspacePath })
  const candidateSha = (
    await gitExecFileAsync(['rev-parse', 'HEAD'], { cwd: workspacePath })
  ).stdout.trim()
  return { workspacePath, destinationRoot, candidateSha }
}

function handoff(path: string): SessionFollowUpRule {
  return {
    revision: 1,
    taskId: 'btk_root',
    taskTitle: 'Inventory report',
    sessionLabel: 'producer',
    recipients: [
      {
        employeeId: 'emp_recipient',
        name: 'Recipient',
        operationId: 'operation123',
        delivery: 'pending'
      }
    ],
    deliverables: { kind: 'files', paths: [path] },
    includeSummary: false,
    note: 'Review the report.',
    savedAt: 1
  }
}

describe('accepted Git handoff deliverable materialization', () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  })

  it('materializes exact accepted candidate bytes at the chosen path without overwriting', async () => {
    const fixture = await repository()
    const destination = join(fixture.destinationRoot, 'inventory-report.md')
    await materializeSessionOutcomeGitDeliverables({
      workspacePath: fixture.workspacePath,
      candidateSha: fixture.candidateSha,
      handoff: handoff(destination)
    })
    expect(await readFile(destination, 'utf8')).toBe('accepted report\n')

    await writeFile(destination, 'user edit\n')
    await expect(
      materializeSessionOutcomeGitDeliverables({
        workspacePath: fixture.workspacePath,
        candidateSha: fixture.candidateSha,
        handoff: handoff(destination)
      })
    ).rejects.toThrow('destination changed')
    expect(await readFile(destination, 'utf8')).toBe('user edit\n')
  })

  it('refuses ambiguous candidate filenames instead of guessing', async () => {
    const fixture = await repository()
    await mkdir(join(fixture.workspacePath, 'other'))
    await writeFile(join(fixture.workspacePath, 'other', 'inventory-report.md'), 'other\n')
    await gitExecFileAsync(['add', '.'], { cwd: fixture.workspacePath })
    await gitExecFileAsync(['commit', '-m', 'ambiguous'], { cwd: fixture.workspacePath })
    const candidateSha = (
      await gitExecFileAsync(['rev-parse', 'HEAD'], { cwd: fixture.workspacePath })
    ).stdout.trim()
    await expect(
      materializeSessionOutcomeGitDeliverables({
        workspacePath: fixture.workspacePath,
        candidateSha,
        handoff: handoff(join(fixture.destinationRoot, 'inventory-report.md'))
      })
    ).rejects.toThrow('multiple files')
  })

  it.skipIf(process.platform === 'win32')(
    'materializes through a symlinked workspace ancestor and a relative in-workspace path',
    async () => {
      const fixture = await repository()
      const alias = join(fixture.destinationRoot, 'alias')
      await symlink(dirname(fixture.workspacePath), alias)
      await mkdir(join(fixture.workspacePath, 'out'))
      const workspacePath = join(alias, 'repo')
      const outside = join(alias, 'chosen', 'inventory-report.md')
      await materializeSessionOutcomeGitDeliverables({
        workspacePath,
        candidateSha: fixture.candidateSha,
        handoff: {
          ...handoff(outside),
          deliverables: { kind: 'files', paths: [outside, 'out/inventory-report.md'] }
        }
      })
      expect(await readFile(join(fixture.destinationRoot, 'inventory-report.md'), 'utf8')).toBe(
        'accepted report\n'
      )
      expect(
        await readFile(join(fixture.workspacePath, 'out', 'inventory-report.md'), 'utf8')
      ).toBe('accepted report\n')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'refuses a symlinked folder inside the workspace',
    async () => {
      const fixture = await repository()
      await symlink(fixture.destinationRoot, join(fixture.workspacePath, 'out'))
      await expect(
        materializeSessionOutcomeGitDeliverables({
          workspacePath: fixture.workspacePath,
          candidateSha: fixture.candidateSha,
          handoff: handoff('out/inventory-report.md')
        })
      ).rejects.toThrow('symbolic link')
      await expect(readFile(join(fixture.destinationRoot, 'inventory-report.md'))).rejects.toThrow()
    }
  )

  it.skipIf(process.platform === 'win32')(
    'refuses a symlinked folder inside the workspace whose name begins with two dots',
    async () => {
      const fixture = await repository()
      await symlink(fixture.destinationRoot, join(fixture.workspacePath, '..out'))
      await expect(
        materializeSessionOutcomeGitDeliverables({
          workspacePath: fixture.workspacePath,
          candidateSha: fixture.candidateSha,
          handoff: handoff('..out/inventory-report.md')
        })
      ).rejects.toThrow('symbolic link')
      await expect(readFile(join(fixture.destinationRoot, 'inventory-report.md'))).rejects.toThrow()
    }
  )

  it.skipIf(process.platform === 'win32')(
    'refuses a deliverable path that reaches the workspace through a THIRD alias neither the ' +
      'literal workspacePath nor the canonical root spelling matched',
    async () => {
      const fixture = await repository()
      const alias = join(dirname(fixture.workspacePath), 'third-alias')
      await symlink(dirname(fixture.workspacePath), alias)
      const outside = join(alias, 'repo', 'inventory-report.md')
      await expect(
        materializeSessionOutcomeGitDeliverables({
          workspacePath: fixture.workspacePath,
          candidateSha: fixture.candidateSha,
          handoff: handoff(outside)
        })
      ).rejects.toThrow('symbolic link')
    }
  )

  it.skipIf(process.platform === 'win32')('refuses a symlink destination', async () => {
    const fixture = await repository()
    const destination = join(fixture.destinationRoot, 'inventory-report.md')
    const outside = join(fixture.destinationRoot, 'outside.md')
    await writeFile(outside, 'outside\n')
    await symlink(outside, destination)
    await expect(
      materializeSessionOutcomeGitDeliverables({
        workspacePath: fixture.workspacePath,
        candidateSha: fixture.candidateSha,
        handoff: handoff(destination)
      })
    ).rejects.toThrow('not a regular file')
    expect(await readFile(outside, 'utf8')).toBe('outside\n')
  })
})
