import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcess } from '../../../shared/child-process/run-process'
import { workflowFleetSweepScript, WORKFLOW_FLEET_RUNS_FOLDER } from './workflow-fleet-retention'

const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe.skipIf(process.platform === 'win32')('fleet run retention', () => {
  it('removes old finished copies while protecting live, unverifiable and unfinished runs', async () => {
    const home = await mkdtemp(join(tmpdir(), 'fleet retention-'))
    folders.push(home)
    const root = join(home, WORKFLOW_FLEET_RUNS_FOLDER)
    for (const name of ['old', 'live', 'unverifiable', 'unfinished', 'missing-pid']) {
      const directory = join(root, name)
      await mkdir(join(directory, 'attempts', 'a'), { recursive: true })
      if (name !== 'unfinished') {
        const marker = join(directory, '.finished')
        await writeFile(marker, '')
        await utimes(marker, new Date(0), new Date(0))
      }
      if (name === 'old') {
        await writeFile(join(directory, 'attempts', 'a', 'pid'), '99999999')
      }
      if (name === 'live' || name === 'unverifiable') {
        await writeFile(
          join(directory, 'attempts', 'a', 'pid'),
          name === 'live' ? String(process.pid) : 'unknown'
        )
      }
    }
    const result = await runProcess({
      program: '/bin/sh',
      args: ['-c', workflowFleetSweepScript(home)],
      timeoutMs: 10000,
      maxOutputBytes: 1024
    })
    expect(result.code).toBe(0)
    expect((await readdir(root)).sort()).toEqual([
      'live',
      'missing-pid',
      'unfinished',
      'unverifiable'
    ])
  })

  it('evicts the oldest finished copy when recent copies exceed the size budget', async () => {
    const home = await mkdtemp(join(tmpdir(), 'fleet-size-'))
    folders.push(home)
    const root = join(home, WORKFLOW_FLEET_RUNS_FOLDER)
    for (const name of ['first', 'second']) {
      await mkdir(join(root, name), { recursive: true })
      await writeFile(join(root, name, 'copy'), 'x'.repeat(100))
      await writeFile(join(root, name, '.finished'), '')
    }
    await utimes(
      join(root, 'first', '.finished'),
      new Date(Date.now() - 10000),
      new Date(Date.now() - 10000)
    )
    const result = await runProcess({
      program: '/bin/sh',
      args: ['-c', workflowFleetSweepScript(home, { maxAgeSeconds: 86400, maxBytes: 150 })],
      timeoutMs: 10000,
      maxOutputBytes: 1024
    })
    expect(result.code).toBe(0)
    expect((await readdir(root)).sort()).toEqual(['second'])
  })
})
