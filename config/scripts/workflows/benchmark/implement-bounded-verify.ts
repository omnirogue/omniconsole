/** The deterministic QA of the implement-bounded set: hidden acceptance tests, run by Node. */
import { cpSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { runProcess } from '../../../../src/shared/child-process/run-process'
import type { BenchTask } from './direct-vs-coordinated-stage'

export const IMPLEMENT_BOUNDED_KIT_DIR = join(import.meta.dirname, 'implement-bounded')

function testCount(output: string, label: 'pass' | 'fail'): number {
  const match = output.match(new RegExp(`^# ${label} (\\d+)$`, 'm'))
  return match ? Number(match[1]) : 0
}

/** A fresh copy of the fixture, without the acceptance tests an agent must not see. */
export function materializeFixture(dir: string): void {
  mkdirSync(join(dir, '..'), { recursive: true })
  cpSync(join(IMPLEMENT_BOUNDED_KIT_DIR, 'fixture'), dir, { recursive: true })
}

export async function verifyAcceptance(
  dir: string,
  task: BenchTask
): Promise<{ pass: number; fail: number; output: string }> {
  mkdirSync(join(dir, 'acceptance'), { recursive: true })
  cpSync(
    join(IMPLEMENT_BOUNDED_KIT_DIR, 'acceptance', task.acceptanceTest),
    join(dir, 'acceptance', task.acceptanceTest)
  )
  const result = await runProcess({
    program: process.execPath,
    // Why the reporter is named: Node 23+ prints the spec reporter when piped, and its summary
    // lines are not the TAP `# pass N` this counts. Unnamed, every run read as zero passes.
    args: ['--test', '--test-reporter=tap', join('acceptance', task.acceptanceTest)],
    cwd: dir,
    timeoutMs: 120_000
  })
  const output = `${result.stdout}\n${result.stderr}`
  const failed = testCount(output, 'fail')
  // Why: a test file that crashes reports no counts; that is a failure, not zero failures.
  return {
    pass: testCount(output, 'pass'),
    fail: result.code === 0 ? failed : Math.max(1, failed),
    output
  }
}
