import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ORCHESTRATION_RESULT_SUBMIT_HANDLER } from './result-submit-handler'

vi.mock('../../format', () => ({ printResult: vi.fn() }))

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function resultFile(contents: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'workflow-result-submit-'))
  directories.push(directory)
  const file = join(directory, 'result.json')
  writeFileSync(file, contents)
  return file
}

function invoke(file: string, call: ReturnType<typeof vi.fn>) {
  return ORCHESTRATION_RESULT_SUBMIT_HANDLER['orchestration result-submit']({
    flags: new Map([
      ['file', file],
      ['dispatch', 'dispatch_1'],
      ['dispatch-capability', 'dcap_worker'],
      ['from', 'worker_1']
    ]),
    client: { call },
    cwd: '/workspace',
    json: true
  } as never)
}

it('sends a parsed JSON value to the exact Dispatch and does not start another worker', async () => {
  const call = vi.fn().mockResolvedValue({ result: { accepted: true } })
  await invoke(resultFile('{"answer":"done"}'), call)
  expect(call).toHaveBeenCalledExactlyOnceWith(
    'orchestration.resultSubmit',
    { dispatch: 'dispatch_1', from: 'worker_1', result: { answer: 'done' } },
    { orchestrationCapability: 'dcap_worker' }
  )
})

it('keeps malformed JSON out of the runtime', async () => {
  const call = vi.fn()
  await expect(invoke(resultFile('{bad'), call)).rejects.toThrow('not valid JSON')
  expect(call).not.toHaveBeenCalled()
})

it('returns a schema defect to the same worker for correction', async () => {
  const call = vi.fn().mockResolvedValue({
    result: { accepted: false, problems: 'answer is required' }
  })
  await expect(invoke(resultFile('{}'), call)).rejects.toThrow('answer is required')
  expect(call).toHaveBeenCalledTimes(1)
})
