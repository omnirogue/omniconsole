import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '../../../shared/child-process/run-process'
import { createFakeFleet, type FakeFleet } from './workflow-fleet.test-fixtures'
import { workflowFleetSeatVerdict } from './workflow-fleet-seat-launch'

let fleet: FakeFleet | undefined
let pid: number | undefined
afterEach(async () => {
  if (pid) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* The test process already exited. */
    }
    pid = undefined
  }
  await fleet?.close()
  fleet = undefined
})

describe.skipIf(process.platform === 'win32')('remote seat stop confirmation', () => {
  it('escalates a TERM-ignoring seat to KILL and confirms exit', async () => {
    fleet = await createFakeFleet(['worker'])
    const directory = join(fleet.host('worker').home, 'attempt')
    await mkdir(directory)
    const pidfile = join(directory, 'pid')
    const started = await runProcess({
      program: '/usr/bin/perl',
      args: [
        '-MPOSIX',
        '-e',
        'my $p = fork(); die "fork" unless defined $p; exit 0 if $p; POSIX::setsid(); open STDIN, "<", "/dev/null"; open STDOUT, ">", "/dev/null"; open STDERR, ">", "/dev/null"; $SIG{TERM} = "IGNORE"; open my $f, ">", $ARGV[0] or die "pid"; print $f "$$"; close $f; sleep 30;',
        pidfile
      ],
      timeoutMs: 5000,
      maxOutputBytes: 1024
    })
    expect(started.code).toBe(0)
    await vi.waitFor(async () => {
      pid = Number(await readFile(pidfile, 'utf8'))
      expect(pid).toBeGreaterThan(1)
    })
    const birth = await runProcess({
      program: 'ps',
      args: ['-p', String(pid), '-o', 'lstart='],
      timeoutMs: 5000,
      maxOutputBytes: 1024
    })
    await writeFile(join(directory, 'started'), birth.stdout)
    await writeFile(join(directory, 'started'), 'a previous incarnation')
    expect(await workflowFleetSeatVerdict('worker', directory, true)).toBe('exited')
    expect(() => process.kill(pid!, 0)).not.toThrow()
    await writeFile(join(directory, 'started'), birth.stdout)
    const before = Date.now()
    expect(await workflowFleetSeatVerdict('worker', directory, true)).toBe('exited')
    expect(Date.now() - before).toBeGreaterThanOrEqual(4500)
    expect(await workflowFleetSeatVerdict('worker', directory, false)).toBe('exited')
  }, 20000)
})
