import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProcessResult } from '../../../../shared/child-process/process-spec'
import { normalizeWorkflowSpec } from '../../../../shared/workflow-graph-normalize'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import { createGraphChecker, runGraphCheck } from './graph-check'
import { graphCheckArgv, graphCheckEnvironment } from './graph-check-launch'
import { GraphJevStore } from './graph-jev-store'
import type { GraphCall } from './graph-plan-types'

const node = `"${process.execPath}"`
const passed: ProcessResult = { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
const call = (command: string): GraphCall =>
  ({ id: 'improve/r1/a0/check', check: { command, candidate: 'candidate' } }) as GraphCall
const failingStore = (message: string) =>
  ({
    read: () => undefined,
    write: () => {
      throw new Error(message)
    }
  }) as unknown as GraphJevStore

let dir = ''
const scratch = () => (dir = mkdtempSync(join(tmpdir(), 'check-containment-')))
const stores = (root: string) => ({
  store: GraphJevStore.forExecution('exec', root, 'checks.json'),
  starts: GraphJevStore.forExecution('exec', root, 'check-starts.json')
})
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
  }
  dir = ''
})

describe('what a check can reach', () => {
  it("never hands the app's secrets to the code it runs", async () => {
    process.env.OMNI_CHECK_TEST_SECRET = 'secret-from-desktop-process'
    try {
      const result = await runGraphCheck(
        {
          command: `${node} {code}`,
          candidate:
            '```js\nconsole.log(process.env.OMNI_CHECK_TEST_SECRET ?? "none", typeof process.env.PATH)\nprocess.exit(1)\n```'
        },
        { cwd: scratch() }
      )
      expect(result.detail).not.toContain('secret-from-desktop-process')
      expect(result.detail).toContain('none string')
    } finally {
      delete process.env.OMNI_CHECK_TEST_SECRET
    }
  })

  it('passes tool locations and locale, and nothing else', () => {
    const extra = { OMNI_CANDIDATE_FILE: '/f' }
    const quiet = { NO_COLOR: '1', FORCE_COLOR: '0' }
    expect(
      graphCheckEnvironment(
        { PATH: '/bin', HOME: '/h', LC_ALL: 'C', OPENAI_API_KEY: 'k', GITHUB_TOKEN: 't' },
        extra,
        'darwin'
      )
    ).toEqual({ PATH: '/bin', HOME: '/h', LC_ALL: 'C', ...quiet, ...extra })
    expect(
      graphCheckEnvironment(
        { Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', AWS_SECRET_ACCESS_KEY: 's' },
        {},
        'win32'
      )
    ).toEqual({ Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', ...quiet })
  })
})

describe('how a check ends', () => {
  it('ends the whole process tree at the time limit', async () => {
    const root = scratch()
    const sentinel = join(root, 'escaped.txt')
    writeFileSync(
      join(root, 'parent.mjs'),
      [
        "import { spawn } from 'node:child_process'",
        "const late = \"setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'x'), 1500)\"",
        "spawn(process.execPath, ['-e', late, process.argv[2]], { stdio: 'ignore' }).unref()",
        'setInterval(() => {}, 10000)'
      ].join('\n')
    )
    const result = await runGraphCheck(
      { command: `${node} parent.mjs "${sentinel}"`, candidate: 'x' },
      { cwd: root, timeoutMs: 300 }
    )
    expect(result).toMatchObject({ passed: false })
    expect(result.detail).toMatch(/Timed out/)
    await delay(2_000)
    expect(existsSync(sentinel)).toBe(false)
  }, 10_000)

  it('ends a running check when the run stops, and records nothing', async () => {
    const root = scratch()
    const { store, starts } = stores(root)
    const stop = new AbortController()
    const checker = createGraphChecker({
      store,
      starts,
      workspace: async () => root,
      signal: stop.signal
    })
    const running = checker(call(`${node} -e "setInterval(() => {}, 1000)"`))
    setTimeout(() => stop.abort(new Error('Workflow stopped')), 300)
    await expect(running).rejects.toThrow('Workflow stopped')
    // Nothing kept: resuming the run checks this version afresh.
    expect(store.all()).toEqual({})
    expect(starts.all()).toEqual({})
  }, 10_000)

  it("takes one of the run's process slots", async () => {
    const root = scratch()
    const order: string[] = []
    const checker = createGraphChecker({
      ...stores(root),
      workspace: async () => root,
      slot: async <T>(work: () => Promise<T>): Promise<T> => {
        order.push('slot')
        const value = await work()
        order.push('released')
        return value
      },
      run: async () => {
        order.push('run')
        return passed
      }
    })
    await checker(call('npm test'))
    expect(order).toEqual(['slot', 'run', 'released'])
  })
})

describe('a check runs at most once', () => {
  it('never runs a check again when its result was not saved', async () => {
    const root = scratch()
    const { store, starts } = stores(root)
    let runs = 0
    const run = async () => {
      runs++
      return passed
    }
    // The first attempt ran the command, then could not save what it found.
    const lost = createGraphChecker({
      store: failingStore('disk full'),
      starts,
      workspace: async () => root,
      run
    })
    await expect(lost(call('npm test'))).rejects.toThrow('disk full')
    await expect(lost(call('npm test'))).rejects.toThrow('disk full')
    const resumed = createGraphChecker({ store, starts, workspace: async () => root, run })
    const outcome = await resumed(call('npm test'))
    expect(runs).toBe(1)
    expect(outcome).toMatchObject({ value: { passed: false, unavailable: true } })
    expect(JSON.stringify(outcome)).toContain('not run twice')
    expect(store.read('improve/r1/a0/check')?.outcome).toEqual(outcome)
  })

  it('never starts a check whose start cannot be recorded', async () => {
    let runs = 0
    const checker = createGraphChecker({
      store: failingStore('read-only disk'),
      starts: failingStore('read-only disk'),
      workspace: async () => scratch(),
      run: async () => {
        runs++
        return passed
      }
    })
    await expect(checker(call('npm test'))).rejects.toThrow('read-only disk')
    expect(runs).toBe(0)
  })
})

describe('the command runs exactly as typed', () => {
  it('keeps Windows paths, quoted spaces and sh escapes', () => {
    expect(
      graphCheckArgv(String.raw`"C:\Program Files\node.exe" C:\bench\run.js`, 'win32')
    ).toEqual([String.raw`C:\Program Files\node.exe`, String.raw`C:\bench\run.js`])
    expect(graphCheckArgv(String.raw`echo \"hi\"`, 'win32')).toEqual(['echo', '"hi"'])
    expect(graphCheckArgv(String.raw`node "a\b" a\ b 'c\d' "say \"x\""`, 'linux')).toEqual([
      'node',
      String.raw`a\b`,
      'a b',
      String.raw`c\d`,
      'say "x"'
    ])
    const spec = workflowTemplate('improve', ['claude', 'codex'])
    const typed = `node -e "console.log('a  b')"`
    const read = normalizeWorkflowSpec({
      ...spec,
      repeat: { ...spec.repeat!, check: { command: `  ${typed}\n` } }
    })
    expect(read.repeat?.check?.command).toBe(typed)
  })
})
