import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { publishConsoleFolderArtifact } from './console-folder-artifact'
import {
  executionBinding,
  executionHandoff,
  executionPrincipal
} from './console-workflow-execution-test-fixture'
import { normalizeConsoleWorkflowHandoff } from './console-workflow-handoff'
import { captureConsoleWorkflowPerson } from './console-workflow-person'

const sentinel = 'opaque-artifact-bearer-sentinel'
vi.mock('./console-workflow-person', () => ({
  captureConsoleWorkflowPerson: vi.fn(),
  redactConsoleWorkflowMemory: (value: unknown) =>
    JSON.parse(JSON.stringify(value).split('opaque-artifact-bearer-sentinel').join('[REDACTED]'))
}))
const fetchMock = vi.fn<typeof fetch>()
type Input = Parameters<typeof publishConsoleFolderArtifact>[0]
const report = '{\n  "outcome": "succeeded", "result": "Created café notes."\n}\n'
const bytes = Buffer.from(report)
const sha256 = createHash('sha256').update(bytes).digest('hex')
let current = true

function input(): Input {
  return {
    binding: structuredClone(executionBinding),
    principal: executionPrincipal,
    job: normalizeConsoleWorkflowHandoff(
      {
        ...executionHandoff(),
        canonical_binding: {
          task_id: executionBinding.taskId,
          contract_id: executionBinding.contractId!,
          contract_digest: executionBinding.contractDigest!,
          contract_generation: executionBinding.contractGeneration!
        },
        provider: 'codex',
        actor_type: 'ai',
        placement: 'local',
        repo: null,
        base_branch: null,
        workspace: { kind: 'folder', path: '/workspace/notes' },
        acceptance_commands: [],
        workflow: { ...executionHandoff().workflow, action: 'execute' }
      },
      [],
      true
    ),
    contentBase64: bytes.toString('base64')
  }
}

function receipt() {
  return {
    job_id: executionBinding.jobId,
    attempt: executionBinding.attempt,
    file_id: 'tfl_abc12345',
    principal: 'emp_sal',
    sha256,
    rel: `uploads/${executionBinding.jobId}-${executionBinding.attempt}-work-result.json`,
    size_bytes: bytes.length
  }
}

function reply(patch: Record<string, unknown> = {}) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ...receipt(), ...patch })))
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  current = true
  vi.mocked(captureConsoleWorkflowPerson).mockResolvedValue({
    ok: true,
    data: {
      bearer: sentinel,
      principal: executionPrincipal,
      baseUrl: 'https://console.example.test',
      isCurrent: () => current
    }
  })
})

describe('claimed folder result artifact transport', () => {
  it('replays the exact original bytes and claim without creating a second client identity', async () => {
    reply()
    reply()
    const request = input()
    const expected = { ok: true, data: { fileId: 'tfl_abc12345', sha256 } }
    expect(await publishConsoleFolderArtifact(request)).toEqual(expected)
    expect(await publishConsoleFolderArtifact(request)).toEqual(expected)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(
      `https://console.example.test/api/gtd/workflow-jobs/${executionBinding.jobId}/artifact`
    )
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error' })
    expect(JSON.parse(init!.body as string)).toEqual({
      host: executionBinding.claim!.host,
      attempt: executionBinding.attempt,
      claimed_at: executionBinding.claim!.claimedAt,
      path: 'work-result.json',
      plan_revision: request.job.digest,
      content_b64: request.contentBase64,
      runner_instance: executionBinding.claim!.runnerInstance,
      lease_generation: executionBinding.leaseGeneration,
      claim_request_id: executionBinding.claim!.claimRequestId,
      attempt_intent_id: executionBinding.claim!.attemptIntentId,
      dispatch_key: executionBinding.claim!.dispatchKey
    })
    expect(fetchMock.mock.calls[1][1]!.body).toBe(init!.body)
    expect(init!.body).not.toContain(sentinel)
  })

  const invalidInputs: [string, (value: Input) => void][] = [
    [
      'missing claim',
      (value) => {
        value.binding.claim = undefined
      }
    ],
    [
      'incomplete claim',
      (value) => {
        value.binding.claim!.claimRequestId = ''
      }
    ],
    [
      'nonlocal claim',
      (value) => {
        value.binding.claim!.host = 'fleet:worker'
      }
    ],
    [
      'missing input digest',
      (value) => {
        value.binding.inputDigest = undefined
      }
    ],
    [
      'different task',
      (value) => {
        value.job.taskId = 'btk_other'
      }
    ],
    [
      'different job',
      (value) => {
        value.job.id = 'job_other12345'
      }
    ],
    [
      'different workflow',
      (value) => {
        value.job.workflowId = 'wf_other12345'
      }
    ],
    [
      'unfrozen plan',
      (value) => {
        value.job.digest = 'invalid'
      }
    ],
    [
      'nonfolder execution',
      (value) => {
        value.job.workspace = undefined
      }
    ],
    [
      'missing principal',
      (value) => {
        value.principal = undefined as unknown as string
      }
    ],
    [
      'invalid principal',
      (value) => {
        value.principal = ''
      }
    ],
    [
      'noncanonical base64',
      (value) => {
        value.contentBase64 += '\n'
      }
    ]
  ]
  it.each(invalidInputs)('refuses %s before any request', async (_name, mutate) => {
    const request = input()
    mutate(request)
    expect(await publishConsoleFolderArtifact(request)).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' }
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['malformed JSON', '{'],
    ['array report', '["result"]'],
    ['scalar report', '"result"'],
    ['null report', 'null'],
    ['empty object', '{}'],
    ['nonfinite number', '{"value":1e999}'],
    ['oversized report', JSON.stringify({ result: 'x'.repeat(65_536) })]
  ])('refuses %s without sending its content', async (_name, source) => {
    const request = input()
    request.contentBase64 = Buffer.from(source).toString('base64')
    expect(await publishConsoleFolderArtifact(request)).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' }
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    { job_id: 'job_other12345' },
    { attempt: executionBinding.attempt + 1 },
    { sha256: '0'.repeat(64) },
    { size_bytes: bytes.length + 1 },
    { rel: 'uploads/unrelated.json' },
    { file_id: 'hfv_wrongtype' },
    { principal: '' }
  ])('refuses changed artifact receipt pins: %j', async (patch) => {
    reply(patch)
    expect(await publishConsoleFolderArtifact(input())).toMatchObject({
      ok: false,
      error: { code: 'invalid_response' }
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('requires the original signed person before requesting upload', async () => {
    const request = input()
    request.principal = 'b'.repeat(64)
    expect(await publishConsoleFolderArtifact(request)).toMatchObject({
      ok: false,
      error: { code: 'principal_mismatch' }
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses an account change before the request', async () => {
    current = false
    expect(await publishConsoleFolderArtifact(input())).toMatchObject({
      ok: false,
      error: { code: 'connection_changed' }
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not adopt a receipt after an account change during the request', async () => {
    fetchMock.mockImplementationOnce(async () => {
      current = false
      return new Response(JSON.stringify(receipt()))
    })
    expect(await publishConsoleFolderArtifact(input())).toMatchObject({
      ok: false,
      error: { code: 'connection_changed' }
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('preserves a server stale claim refusal without a second upload', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: false,
          error: { code: 'stale_claim', message: 'The folder attempt no longer owns this claim.' }
        }),
        { status: 409 }
      )
    )
    expect(await publishConsoleFolderArtifact(input())).toMatchObject({
      ok: false,
      error: { code: 'stale_claim' }
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})

it('uploads a Git report only through its explicit frozen artifact contract', async () => {
  const request = input()
  request.job.workspace = undefined
  request.job.repo = 'Example/project'
  request.job.baseBranch = 'main'
  request.job.baseSha = 'a'.repeat(40)
  request.job.artifactResult = { path: 'work-result.json', format: 'json', maxBytes: 65536 }
  reply()
  expect(await publishConsoleFolderArtifact(request)).toMatchObject({ ok: true, data: { sha256 } })
  expect(fetchMock).toHaveBeenCalledOnce()
})
