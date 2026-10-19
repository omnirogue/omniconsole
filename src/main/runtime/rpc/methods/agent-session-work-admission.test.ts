import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../omni-runtime'
import type { RpcRequest, RpcResponse } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { AGENT_SESSION_METHODS } from './agent-session'

const readManagedSessionToolsFiles = vi.hoisted(() => vi.fn())
vi.mock('../../managed-session-tools-files', () => ({ readManagedSessionToolsFiles }))

const OPERATION_ID = '1752883200000-0123456789abcdef0123456789abcdef'

// The exact shape the 17 Oct 2026 coordinator script sent.
const wave12 = {
  clientOperationId: OPERATION_ID,
  worktree: 'path:/Users/example/omni-ide-worktrees/item-7',
  agent: 'codex',
  prompt: 'Build the billing export. Done check: write a Markdown file of 150+ lines.',
  promptDelivery: 'auto-submit',
  presentation: 'background',
  revealInSidebar: true,
  viewMode: 'terminal',
  launchPreferences: { model: 'gpt-5.5', effort: 'high' }
}

const buildAsDocument = {
  schema_version: 2,
  work_ref: 'wave12:item-7',
  contract_revision: 1,
  deliverable_kind: 'software_change',
  root: { kind: 'software_change', source: 'decision' },
  requested_outcome: 'Build the billing export',
  target: { repo: 'omnirogue/omni-console', base: 'main' },
  scope: { owned_paths: ['bff/omni_bff/billing.py'] },
  acceptance: [
    { id: 'doc', kind: 'artifact_published', expected: 'Markdown file, minimum 150 lines' }
  ],
  authority: { basis: 'decision', decision: { slug: 'wave-12', revision: 3, decision_id: 9 } }
}

const report = {
  schema_version: 2,
  work_ref: 'research-1',
  contract_revision: 1,
  deliverable_kind: 'report',
  root: { kind: 'report', source: 'operator_request' },
  requested_outcome: 'Compare the three relay providers',
  acceptance: [{ id: 'grounded', kind: 'source_grounding' }],
  authority: { basis: 'operator_request', request: 'Compare relay providers' }
}

function runtimeStub() {
  return {
    getRuntimeId: () => 'runtime-1',
    createAgentSession: vi.fn().mockResolvedValue({
      terminal: { handle: 'term_1', worktreeId: 'worktree-1', title: null },
      disposition: 'created'
    })
  }
}

async function launch(
  params: Record<string, unknown>,
  transport: { clientKind?: 'mobile' | 'runtime'; pairedDeviceId?: string } = {}
): Promise<{ reply: RpcResponse; runtime: ReturnType<typeof runtimeStub> }> {
  const runtime = runtimeStub()
  const dispatcher = new RpcDispatcher({
    runtime: runtime as unknown as OrcaRuntimeService,
    methods: AGENT_SESSION_METHODS
  })
  const request: RpcRequest = {
    id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    authToken: 'token',
    method: 'terminal.createAgentSession',
    params
  }
  if (!transport.clientKind) {
    return { reply: await dispatcher.dispatch(request), runtime }
  }
  const replies: RpcResponse[] = []
  await dispatcher.dispatchStreaming(
    request,
    (response) => replies.push(JSON.parse(response) as RpcResponse),
    {
      clientId: transport.pairedDeviceId,
      pairedDeviceId: transport.pairedDeviceId,
      clientKind: transport.clientKind
    }
  )
  return { reply: replies[0], runtime }
}

describe('terminal.createAgentSession work contract admission', () => {
  beforeEach(() => {
    readManagedSessionToolsFiles.mockReset()
    readManagedSessionToolsFiles.mockImplementation(() => {
      throw new Error('managed_session_tools_file_untrusted')
    })
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('admits the Wave12 launch in shadow and records it as uncontracted', async () => {
    const { reply, runtime } = await launch(wave12)

    expect(reply).toMatchObject({
      ok: true,
      result: { disposition: 'created', workAdmission: { status: 'uncontracted', mode: 'shadow' } }
    })
    expect(runtime.createAgentSession).toHaveBeenCalledOnce()
  })

  it('refuses the Wave12 launch in enforce before any terminal is created', async () => {
    vi.stubEnv('OMNI_WORK_CONTRACT_ADMISSION', 'enforce')
    const { reply, runtime } = await launch(wave12)

    expect(reply).toMatchObject({
      ok: false,
      error: {
        code: 'work_contract_required',
        data: { workAdmission: { status: 'uncontracted', mode: 'enforce' } }
      }
    })
    expect(runtime.createAgentSession).not.toHaveBeenCalled()
  })

  it('refuses a software change proven by a long document even in shadow', async () => {
    const { reply, runtime } = await launch({ ...wave12, workContract: buildAsDocument })

    expect(reply).toMatchObject({ ok: false, error: { code: 'deliverable_mismatch' } })
    const problems = (
      reply as { error: { data: { workAdmission: { problems: { code: string }[] } } } }
    ).error.data.workAdmission.problems.map((problem) => problem.code)
    expect(problems).toContain('line_count_acceptance')
    expect(runtime.createAgentSession).not.toHaveBeenCalled()
  })

  it('admits a valid report contract and passes it to the runtime fingerprint', async () => {
    const { reply, runtime } = await launch({ ...wave12, workContract: report })

    expect(reply).toMatchObject({
      ok: true,
      result: {
        workAdmission: {
          status: 'contracted',
          authorityVerified: false,
          workRef: 'research-1',
          deliverableKind: 'report'
        }
      }
    })
    expect(runtime.createAgentSession.mock.calls[0][0]).toMatchObject({ workContract: report })
  })

  it('ignores a caller-supplied interactive launchCause', async () => {
    vi.stubEnv('OMNI_WORK_CONTRACT_ADMISSION', 'enforce')
    const { reply, runtime } = await launch({
      ...wave12,
      launchCause: { trigger: 'interactive', actor: { kind: 'mobile' } }
    })

    expect(reply).toMatchObject({ ok: false, error: { code: 'work_contract_required' } })
    expect(runtime.createAgentSession).not.toHaveBeenCalled()
  })

  it('keeps a person launch from the mobile lane interactive', async () => {
    vi.stubEnv('OMNI_WORK_CONTRACT_ADMISSION', 'enforce')
    const { reply } = await launch(
      { clientOperationId: OPERATION_ID, worktree: wave12.worktree, agent: 'codex' },
      { clientKind: 'mobile', pairedDeviceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }
    )

    expect(reply).toMatchObject({
      ok: true,
      result: { workAdmission: { status: 'interactive', mode: 'enforce' } }
    })
  })

  it('admits a hub launch whose host-owned descriptor validates, in enforce', async () => {
    vi.stubEnv('OMNI_WORK_CONTRACT_ADMISSION', 'enforce')
    readManagedSessionToolsFiles.mockReturnValue({})
    const managedToolsFile = '/Users/example/state/session-tools/op-1/descriptor.json'
    const { reply, runtime } = await launch({ ...wave12, managedToolsFile })

    expect(readManagedSessionToolsFiles).toHaveBeenCalledWith(managedToolsFile, {
      nativeOperationId: OPERATION_ID,
      provider: 'codex'
    })
    expect(reply).toMatchObject({
      ok: true,
      result: { workAdmission: { status: 'hub_admitted', mode: 'enforce' } }
    })
    expect(runtime.createAgentSession).toHaveBeenCalledOnce()
  })

  it('does not treat an unverifiable descriptor as hub admission', async () => {
    vi.stubEnv('OMNI_WORK_CONTRACT_ADMISSION', 'enforce')
    const { reply, runtime } = await launch({
      ...wave12,
      managedToolsFile: '/tmp/forged/descriptor.json'
    })

    expect(reply).toMatchObject({ ok: false, error: { code: 'work_contract_required' } })
    expect(runtime.createAgentSession).not.toHaveBeenCalled()
  })

  it('rejects an oversized contract as an invalid argument', async () => {
    const { reply } = await launch({
      ...wave12,
      workContract: { ...report, requested_outcome: 'x'.repeat(70 * 1024) }
    })

    expect(reply).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
  })
})
