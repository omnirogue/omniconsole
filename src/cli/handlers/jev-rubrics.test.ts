import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../args'
import type { RuntimeClient } from '../runtime-client'
import {
  JEV_RUBRICS_RUNTIME_CAPABILITY,
  JEV_RUBRIC_MAX_INPUT_BYTES
} from '../../shared/jev-rubrics'
import { JEV_RUBRIC_HANDLERS, readJevRubricStdin } from './jev-rubrics'

let dir: string
const rubric = { name: 'Clear', instructions: '- Answers directly', kind: 'reply' }
const evaluation = { rubric: 'Clear', task: 'Answer the question', response: 'The answer' }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jev-rubric-cli-'))
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.stubEnv('ORCA_CLI_CWD', '')
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

function invocation(argv: string[], capabilities: string[] = [JEV_RUBRICS_RUNTIME_CAPABILITY]) {
  const parsed = parseArgs(['jev', 'rubrics', ...argv])
  const call = vi.fn(async (method: string) => ({
    id: 'request',
    ok: true,
    result: method === 'status.get' ? { capabilities } : { status: 'unknown', kind: 'missing' }
  }))
  return {
    call,
    run: () =>
      JEV_RUBRIC_HANDLERS[parsed.commandPath.join(' ')]!({
        flags: parsed.flags,
        client: { call } as unknown as RuntimeClient,
        cwd: dir,
        json: true
      })
  }
}

function writeInput(value: unknown) {
  writeFileSync(join(dir, 'input.json'), JSON.stringify(value))
}

describe('JEV rubric CLI capability and input boundaries', () => {
  it('lists only after negotiating the selected runtime capability', async () => {
    const command = invocation(['list'])
    await command.run()
    expect(command.call.mock.calls.map(([method]) => method)).toEqual([
      'status.get',
      'jev.rubrics.list'
    ])
  })

  it.each(['list', 'save', 'evaluate'])(
    'refuses %s on an older runtime without any fallback',
    async (action) => {
      const command = invocation([action, '--file', 'missing.json'], [])
      await expect(command.run()).rejects.toMatchObject({ code: 'unsupported_runtime_capability' })
      expect(command.call).toHaveBeenCalledTimes(1)
    }
  )

  it('saves validated text and requires an explicit replacement flag', async () => {
    writeInput(rubric)
    const command = invocation(['save', '--file', 'input.json', '--replace'])
    await command.run()
    expect(command.call).toHaveBeenLastCalledWith('jev.rubrics.save', { rubric, replace: true })
  })

  it('evaluates supplied work with one-off request as the default', async () => {
    writeInput(evaluation)
    const command = invocation(['evaluate', '--file', 'input.json'])
    await command.run()
    expect(command.call).toHaveBeenLastCalledWith('jev.rubrics.evaluate', {
      input: evaluation,
      control: 'request'
    })
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string)).toEqual({
      status: 'unknown',
      kind: 'missing'
    })
  })

  it('preserves an off request and declared missing evidence', async () => {
    const input = { ...evaluation, evidence: { status: 'missing', text: 'Source absent' } }
    writeInput(input)
    const command = invocation(['evaluate', '--file', 'input.json', '--jev', 'off'])
    await command.run()
    expect(command.call).toHaveBeenLastCalledWith('jev.rubrics.evaluate', { input, control: 'off' })
  })

  it('refuses remote file paths without reading a colliding controller file', async () => {
    writeInput(rubric)
    vi.stubEnv('ORCA_CLI_CWD', '/remote/work')
    const command = invocation(['save', '--file', 'input.json'])
    await expect(command.run()).rejects.toThrow('Pipe the host file')
    expect(command.call).toHaveBeenCalledTimes(1)
  })

  it('accepts forwarded stdin rather than a remote file path', async () => {
    vi.stubEnv('ORCA_CLI_CWD', '/remote/work')
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(
      Readable.from([JSON.stringify(rubric)]) as typeof process.stdin
    )
    const command = invocation(['save', '--input-stdin'])
    await command.run()
    expect(command.call).toHaveBeenLastCalledWith('jev.rubrics.save', { rubric, replace: false })
  })

  it.each([
    ['save'],
    ['save', '--file'],
    ['save', '--file', 'input.json', '--input-stdin'],
    ['save', '--input-stdin=false']
  ])('requires exactly one valid input source: %j', async (...argv) => {
    const command = invocation(argv)
    await expect(command.run()).rejects.toThrow('exactly one')
    expect(command.call).toHaveBeenCalledTimes(1)
  })

  it('rejects malformed, oversized and non-file input before a rubric write', async () => {
    for (const value of ['{', ' '.repeat(48_001)]) {
      writeFileSync(join(dir, 'input.json'), value)
      const command = invocation(['save', '--file', 'input.json'])
      await expect(command.run()).rejects.toMatchObject({ code: 'invalid_argument' })
      expect(command.call).toHaveBeenCalledTimes(1)
    }
    const command = invocation(['save', '--file', '.'])
    await expect(command.run()).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(command.call).toHaveBeenCalledTimes(1)
  })

  it('rejects unknown rubric fields and unsupported controls before evaluation', async () => {
    writeInput({ ...rubric, authority: true })
    const save = invocation(['save', '--file', 'input.json'])
    await expect(save.run()).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(save.call).toHaveBeenCalledTimes(1)
    writeInput(evaluation)
    const evaluate = invocation(['evaluate', '--file', 'input.json', '--jev', 'force'])
    await expect(evaluate.run()).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(evaluate.call).toHaveBeenCalledTimes(1)
  })

  it('bounds stdin in bytes across chunks, including multibyte text', async () => {
    await expect(
      readJevRubricStdin(
        Readable.from(['{"text":"', 'é'.repeat(JEV_RUBRIC_MAX_INPUT_BYTES / 2), '"}'])
      )
    ).rejects.toThrow('48 KB')
    await expect(readJevRubricStdin(Readable.from(['{']))).rejects.toThrow()
    await expect(readJevRubricStdin(Readable.from(['{"name":', '"Clear"}']))).resolves.toEqual({
      name: 'Clear'
    })
  })
})
