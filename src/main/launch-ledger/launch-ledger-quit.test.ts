import { readFileSync } from 'node:fs'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import * as ledger from './launch-ledger'
import { settleTeardownWithinDeadline } from '../quit-teardown-deadline'
describe('launch ledger quit drain', () => {
  it('joins the existing barrier after stopping producers', () => {
    const source = readFileSync(join(__dirname, '../index.ts'), 'utf8')
    expect(source).toContain("{ name: 'launch-ledger', promise: launchLedgerShutdown }")
    expect(source).toMatch(/const launchLedgerShutdown = drainLaunchLedgerAfterProducersStop\(/)
    for (const file of ['../ipc/pty/ipc/spawn-run.ts', '../ipc/pty/runtime/spawn.ts']) {
      expect(readFileSync(join(__dirname, file), 'utf8')).toContain(
        'return trackLaunchProducer(() =>'
      )
    }
  })
  it('an immediate quit waits for producer receipt and queued disk rows', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-quit-'))
    await ledger.setLaunchLedgerDirectory(directory)
    let release!: () => void
    const producer = new Promise<void>((resolve) => {
      release = resolve
    }).then(() =>
      ledger.recordLaunch({
        pipeline: 'runtime-controller',
        ptyId: '11111111-1111-4111-8111-111111111111',
        hasStartupCommand: false,
        process: 'created',
        cause: { trigger: 'terminal-create' }
      })
    )
    try {
      const drain = (
        ledger as unknown as {
          drainLaunchLedgerAfterProducersStop: (producers: Promise<unknown>[]) => Promise<void>
        }
      ).drainLaunchLedgerAfterProducersStop([producer])
      const quitting = settleTeardownWithinDeadline(
        [{ name: 'launch-ledger', promise: drain }],
        5000
      )
      release()
      expect(await quitting).toEqual([])
      const row = JSON.parse(
        (await readFile(join(directory, ledger.LAUNCH_LEDGER_FILE), 'utf8')).trim()
      )
      expect(row).toMatchObject({
        cause: 'terminal-create',
        process: 'created',
        hasStartupCommand: false
      })
    } finally {
      release()
      await producer
      await ledger._resetLaunchLedgerForTests()
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('quit waits for in-flight launch receipts', () => {
  it('drains a producer already active when shutdown begins', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-active-quit-'))
    await ledger.setLaunchLedgerDirectory(directory)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      const active = (
        ledger as unknown as { trackLaunchProducer: (run: () => Promise<void>) => Promise<void> }
      ).trackLaunchProducer(async () => {
        await gate
        ledger.recordLaunch({
          pipeline: 'runtime-controller',
          ptyId: '11111111-1111-4111-8111-111111111111',
          hasStartupCommand: false,
          process: 'created',
          cause: { trigger: 'terminal-create' }
        })
      })
      let completed = false
      const drain = ledger.drainLaunchLedgerAfterProducersStop([]).then(() => {
        completed = true
      })
      await Promise.resolve()
      await Promise.resolve()
      expect(completed).toBe(false)
      release()
      await active
      await drain
      expect(
        JSON.parse((await readFile(join(directory, ledger.LAUNCH_LEDGER_FILE), 'utf8')).trim())
      ).toMatchObject({ process: 'created', cause: 'terminal-create' })
    } finally {
      release()
      await ledger._resetLaunchLedgerForTests()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
