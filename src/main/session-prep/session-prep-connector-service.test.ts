import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { SessionPrepSteps } from '../../shared/session-prep-types'
import type { SessionPrepHost } from './session-prep-host'
import type { ConnectorRegistration } from './session-prep-requests'
import { SessionPrepService } from './session-prep-service'
import { SessionPrepStore } from './session-prep-store'

it('connector service prepares one verbatim item, gates and routes it, and returns the native receipt', async () => {
  const request = 'Research batteries.\nThen write a comparison of the options.'
  const registration: ConnectorRegistration = {
    operator: 'sal',
    digest: 'signed-request-digest',
    nonce: 'e2b79bdd-907a-4f4e-ae34-a5f75c0ad520',
    expiresAt: Math.floor(Date.now() / 1000) + 60,
    statusOnly: false,
    launch: {
      managedToolsFile: '/state/descriptor.json',
      nativeOperationId: '1791410000000-0123456789abcdef0123456789abcdef',
      resultsFolder: '/state/results',
      title: 'Compare batteries'
    }
  }
  const receipt = {
    operationId: registration.launch.nativeOperationId,
    provider: 'codex' as const,
    disposition: 'created',
    terminal: { handle: 'term_actual', paneKey: 'pane-result', tabId: 'tab-result' }
  }
  const createAgentSessionIn = vi.fn().mockResolvedValue({
    worktreeId: 'folder:work',
    paneKey: 'pane-result',
    nativeReceipt: receipt
  })
  const routeDispatch = vi.fn().mockResolvedValue({
    provider: 'codex',
    model: 'gpt-6-astra',
    effort: 'medium',
    tier: 'fast',
    gate: 'jev',
    reason: 'Existing route',
    note: ''
  })
  const host: SessionPrepHost = {
    resolveWorktree: async () => ({
      path: '/work',
      repoId: 'folder:work',
      isFolder: true,
      isRemote: false
    }),
    listRepos: () => [],
    resolveRepo: () => null,
    createAgentSessionIn,
    createWorktreeWithAgent: vi.fn(),
    worktreeExistsByName: async () => false,
    findWorktreeIdByName: async () => null,
    isAgentEnabled: () => true,
    routeDispatch,
    routingMode: () => 'live',
    createBatchFolder: async () => ({ id: 'batch', path: 'App tasks' }),
    fileSession: async () => ({ path: 'App tasks' })
  }
  const prepare = vi.fn<SessionPrepSteps['prepare']>().mockImplementation(async ({ item }) => ({
    title: item.title,
    outcome: item.ask,
    doneWhen: ['The comparison is complete'],
    decided: [],
    references: [],
    constraints: [],
    assumptions: [],
    blockingQuestion: null,
    changesCode: false
  }))
  const gate = vi.fn<SessionPrepSteps['gate']>().mockResolvedValue({
    pass: true,
    failures: [],
    ask: null,
    scores: {},
    judge: 'deterministic'
  })
  const plan = vi.fn<SessionPrepSteps['plan']>()
  const steps: SessionPrepSteps = {
    plan,
    prepare,
    gate,
    revise: vi.fn(),
    render: ({ item, fields }) => `${item.ask}\n\nOutcome\n${fields.outcome}`,
    renderDirect: ({ item }) => item.ask
  }
  const store = new SessionPrepStore(await mkdtemp(join(tmpdir(), 'connector-service-')))
  const service = new SessionPrepService({ host, store, steps: () => steps })
  await service.start()
  const params = {
    text: request,
    requestId: 'connector-operation',
    context: '',
    source: {
      worktreeId: 'folder:work',
      paneKey: 'connector-operation',
      agent: 'codex' as const
    }
  }
  const accepted = await service.requestConnector(params, registration)
  await vi.waitFor(() => expect(service.get(accepted.batchId).state).toBe('done'), {
    timeout: 5000
  })
  const status = await service.requestConnector(params, { ...registration, statusOnly: true })
  expect(status.state).toBe('launched')
  expect(status.nativeReceipt).toEqual(receipt)
  expect(status.batch.items).toHaveLength(1)
  expect(plan).not.toHaveBeenCalled()
  expect(prepare).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      request,
      item: expect.objectContaining({ ask: request, anchor: request }),
      siblings: []
    })
  )
  expect(gate).toHaveBeenCalledOnce()
  expect(routeDispatch).toHaveBeenCalledOnce()
  expect(createAgentSessionIn).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      agent: 'codex',
      launch: { model: 'gpt-6-astra', effort: 'medium' },
      clientOperationId: registration.launch.nativeOperationId,
      connectorLaunch: registration.launch,
      prompt: expect.stringContaining(
        "Save finished deliverable files in this session's results folder: /state/results."
      )
    })
  )
  expect(createAgentSessionIn.mock.calls[0]?.[0].prompt.startsWith(request)).toBe(true)
})
