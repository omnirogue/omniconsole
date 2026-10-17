import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { runProcess, spawnProcess } from '../../../shared/child-process/run-process'
import { CANONICAL_WORKER_GATE_PYTHON, canonicalWorkerBindingHash } from './canonical-worker-gate'

const supported = process.platform === 'darwin' || process.platform === 'linux'
const binding = {
  worker_dispatch_id: 'dispatch-1',
  generation: 1,
  nested: { z: 'é', a: ['identity', true, null], '10': 10, '2': 2 }
}
const privateArgument = 'private argument $(`not-a-command`) "quoted"'
const privateEnvironment = 'private-env-value'
type Receipt = Record<string, unknown>
const active: ReturnType<typeof spawnGate>[] = []
let python = ''

function readJson(file: string): Receipt {
  return JSON.parse(readFileSync(file, 'utf8')) as Receipt
}

function writePrivate(file: string, value: unknown): void {
  writeFileSync(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 })
  renameSync(`${file}.tmp`, file)
}

function spawnGate(
  options: {
    timeout?: string
    launchOverrides?: Record<string, unknown>
  } = {}
) {
  const directory = mkdtempSync(join(tmpdir(), "canonical gate '$-"))
  const script = join(directory, 'gate.py')
  const provider = join(directory, 'provider.py')
  const sentinel = join(directory, 'provider-started.json')
  const injectionSentinel = join(directory, 'python-startup-ran')
  const nonce = randomBytes(24).toString('hex')
  writeFileSync(script, CANONICAL_WORKER_GATE_PYTHON, { mode: 0o600 })
  writeFileSync(
    provider,
    String.raw`
import json, os, subprocess, sys
with open(sys.argv[1], "w") as stream:
    json.dump(dict(pid=os.getpid(), pgid=os.getpgrp(),
        started_at=subprocess.check_output(["/bin/ps", "-p", str(os.getpid()), "-o", "lstart="],
            env={**os.environ, "LC_ALL":"C"}, text=True).strip(),
        argument=sys.argv[2], environment=os.environ["GATE_TEST_PRIVATE"], cwd=os.getcwd()), stream)
sys.exit(23)
`,
    { mode: 0o600 }
  )
  writeFileSync(
    join(directory, 'sitecustomize.py'),
    `open(${JSON.stringify(injectionSentinel)}, "w").close()`,
    { mode: 0o600 }
  )
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  )
  writePrivate(join(directory, 'launch.json'), {
    binding,
    runnerInstance: 'runner-1',
    argv: [python, '-I', '-S', provider, sentinel, privateArgument],
    env: { ...environment, GATE_TEST_PRIVATE: privateEnvironment },
    cwd: directory,
    gatePython: python,
    ...options.launchOverrides
  })
  const child = spawnProcess({
    program: python,
    args: ['-I', '-S', script, directory, nonce, options.timeout ?? '5'],
    env: { ...environment, PYTHONPATH: directory }
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  return {
    directory,
    sentinel,
    injectionSentinel,
    nonce,
    child,
    exited,
    output: () => stdout + stderr,
    state: () => readJson(join(directory, 'process.json')),
    async prepared() {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (existsSync(join(directory, 'process.json'))) {
          return this.state()
        }
        if (child.exitCode !== null) {
          throw new Error(`Gate exited before prepared: ${child.exitCode}`)
        }
        await delay(10)
      }
      throw new Error('Gate did not prepare')
    },
    permit(state: Receipt, overrides: Receipt = {}) {
      writePrivate(join(directory, 'permit.json'), {
        nonce,
        binding_hash: canonicalWorkerBindingHash(binding),
        pid: state.pid,
        started_at: state.started_at,
        runner_instance: state.runner_instance,
        ...overrides
      })
    }
  }
}

function gate(options?: Parameters<typeof spawnGate>[0]) {
  const fixture = spawnGate(options)
  active.push(fixture)
  return fixture
}

describe('canonical worker binding hash', () => {
  it.each([1.5, Infinity, new Date(), '\ud800'])(
    'rejects values with ambiguous JSON serialization: %s',
    (value) => {
      expect(() => canonicalWorkerBindingHash({ value })).toThrow()
    }
  )
})

describe.skipIf(!supported)('canonical worker process gate', () => {
  beforeAll(async () => {
    const result = await runProcess({
      program: 'python3',
      args: ['-I', '-S', '-c', 'import sys; print(sys.executable)']
    })
    expect(result.code).toBe(0)
    python = result.stdout.trim()
    expect(python.startsWith('/')).toBe(true)
  })

  afterEach(async () => {
    for (const fixture of active.splice(0)) {
      if (fixture.child.exitCode === null && fixture.child.signalCode === null) {
        fixture.child.kill('SIGKILL')
      }
      await fixture.exited
      rmSync(fixture.directory, { recursive: true, force: true })
    }
  })

  it('stays blocked without a permit and expires without claiming an observed exit', async () => {
    const fixture = gate({ timeout: '1' })
    const prepared = await fixture.prepared()
    expect(prepared).toMatchObject({
      phase: 'prepared',
      launch_gate_closed: true,
      process_exited: false,
      exit_code: null
    })
    expect(prepared.pid).toBe(fixture.child.pid)
    expect(prepared.pgid).toBe(prepared.pid)
    expect(existsSync(fixture.sentinel)).toBe(false)
    expect(existsSync(join(fixture.directory, 'launch.json'))).toBe(false)
    expect(existsSync(fixture.injectionSentinel)).toBe(false)
    expect(await fixture.exited).toBe(125)
    expect(fixture.state()).toMatchObject({
      phase: 'aborted',
      reason: 'gate_timeout',
      launch_gate_closed: true,
      process_exited: false,
      exit_code: null
    })
    expect(existsSync(fixture.sentinel)).toBe(false)
    expect(fixture.output()).toBe('')
  })

  it('executes only the exact permit, preserving prepared PID, birth and process group', async () => {
    const fixture = gate()
    const prepared = await fixture.prepared()
    expect(prepared.binding_hash).toBe(canonicalWorkerBindingHash(binding))
    await delay(100)
    expect(existsSync(fixture.sentinel)).toBe(false)
    fixture.permit(prepared)
    expect(await fixture.exited).toBe(23)
    expect(readJson(fixture.sentinel)).toEqual({
      pid: prepared.pid,
      pgid: prepared.pgid,
      started_at: prepared.started_at,
      argument: privateArgument,
      environment: privateEnvironment,
      cwd: realpathSync(fixture.directory)
    })
    expect(fixture.state()).toMatchObject({
      phase: 'released',
      launch_gate_closed: false,
      process_exited: false,
      exit_code: null
    })
    expect(existsSync(join(fixture.directory, 'permit.json'))).toBe(false)
    expect(JSON.stringify(fixture.state())).not.toContain(privateArgument)
    expect(JSON.stringify(fixture.state())).not.toContain(privateEnvironment)
    expect(fixture.output()).toBe('')
  })

  it.each([
    { nonce: 'wrong-nonce' },
    { binding_hash: 'wrong-binding' },
    { pid: 1 },
    { pid: true },
    { started_at: 'stale-birth' },
    { runner_instance: 'runner-2' },
    { nonce: null },
    { started_at: 123 },
    { binding_hash: null }
  ])('rejects a mismatched or mistyped permit: %j', async (overrides) => {
    const fixture = gate()
    fixture.permit(await fixture.prepared(), overrides)
    expect(await fixture.exited).toBe(125)
    expect(fixture.state()).toMatchObject({ phase: 'aborted', launch_gate_closed: true })
    expect(existsSync(fixture.sentinel)).toBe(false)
  })

  it('rejects a replayed permit belonging to an earlier gate', async () => {
    const first = gate()
    const previous = await first.prepared()
    first.child.kill('SIGTERM')
    expect(await first.exited).toBe(125)
    const next = gate()
    await next.prepared()
    next.permit(previous, { nonce: first.nonce })
    expect(await next.exited).toBe(125)
    expect(existsSync(next.sentinel)).toBe(false)
  })

  it.each(['{', '[]', '{}'])('fails closed on malformed/incomplete permit %s', async (content) => {
    const fixture = gate()
    await fixture.prepared()
    writeFileSync(join(fixture.directory, 'permit.json'), content, { mode: 0o600 })
    expect(await fixture.exited).toBe(125)
    expect(existsSync(fixture.sentinel)).toBe(false)
  })

  it.each(['public', 'symlink', 'fifo'])(
    'rejects an unsafe %s permit without blocking',
    async (kind) => {
      const fixture = gate()
      await fixture.prepared()
      const permit = join(fixture.directory, 'permit.json')
      if (kind === 'public') {
        writeFileSync(`${permit}.pending`, '{}', { mode: 0o600 })
        chmodSync(`${permit}.pending`, 0o644)
        renameSync(`${permit}.pending`, permit)
      } else if (kind === 'symlink') {
        symlinkSync(join(fixture.directory, 'process.json'), permit)
      } else {
        expect((await runProcess({ program: 'mkfifo', args: [permit] })).code).toBe(0)
      }
      expect(await fixture.exited).toBe(125)
      expect(existsSync(fixture.sentinel)).toBe(false)
    }
  )

  it('cannot execute if the release receipt cannot be committed', async () => {
    const fixture = gate()
    const prepared = await fixture.prepared()
    mkdirSync(join(fixture.directory, 'process.json.tmp'))
    fixture.permit(prepared)
    expect(await fixture.exited).toBe(125)
    expect(existsSync(fixture.sentinel)).toBe(false)
    expect(fixture.state()).toMatchObject({ phase: 'prepared', launch_gate_closed: true })
  })

  it('aborts safely when exec fails after accepting the permit', async () => {
    const fixture = gate({ launchOverrides: { argv: ['/nonexistent-canonical-gate-provider'] } })
    fixture.permit(await fixture.prepared())
    expect(await fixture.exited).toBe(125)
    expect(fixture.state()).toMatchObject({ phase: 'aborted', launch_gate_closed: true })
    expect(existsSync(fixture.sentinel)).toBe(false)
    expect(fixture.output()).toBe('')
  })

  it.each(['nan', 'inf', '-1', '0'])(
    'rejects an unbounded or invalid timeout %s',
    async (timeout) => {
      const fixture = gate({ timeout })
      expect(await fixture.exited).toBe(125)
      expect(existsSync(fixture.sentinel)).toBe(false)
    }
  )
})
