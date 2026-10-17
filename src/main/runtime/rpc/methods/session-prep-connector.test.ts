import { beforeEach, expect, it, vi } from 'vitest'
import { SESSION_PREP_PARAMS, SESSION_PREP_RPC } from '../../../../shared/session-prep-types'
import type { RpcContext } from '../core'
import { SESSION_PREP_METHODS } from './session-prep'
const { authenticate } = vi.hoisted(() => ({ authenticate: vi.fn() }))
vi.mock('../../../session-prep/session-prep-connector-authority', () => ({
  authenticateSessionPrepConnector: authenticate
}))
const launch = {
  managedToolsFile: '/state/descriptor.json',
  nativeOperationId: `1760400000000-${'a'.repeat(32)}`,
  resultsFolder: '/state/results',
  title: 'Research'
}
const params = SESSION_PREP_PARAMS.request.parse({
  text: '  Research this.  ',
  context: 'untrusted context',
  source: { worktreeId: 'folder:wrong', paneKey: 'pretend-renderer', agent: 'claude' },
  connector: { payload: 'signed', signature: 'a'.repeat(86), launch, statusOnly: true }
})
beforeEach(() => {
  authenticate.mockReset().mockReturnValue({
    claims: {
      operator: 'emp_sal',
      requestId: 'operation-1',
      text: params.text,
      provider: 'codex',
      nonce: 'e2b79bdd-907a-4f4e-ae34-a5f75c0ad520',
      expiresAt: 1300
    },
    workspace: '/work',
    digest: 'signed-digest'
  })
})
function fixture(connectionId?: string) {
  const requestConnector = vi.fn(async () => ({ batchId: 'batch-1', state: 'preparing' }))
  const runtime = {
    listFolderWorkspaces: () => [{ id: 'work', folderPath: '/work', connectionId }],
    listRepos: () => [],
    getSessionPrepService: () => ({ requestConnector })
  }
  const context = { clientId: 'cli', runtime } as unknown as RpcContext
  const method = SESSION_PREP_METHODS.find((x) => x.name === SESSION_PREP_RPC.request)!
  return { requestConnector, call: () => method.handler(params, context) }
}
it('maps only signed identity and local workspace to prep, preserving verbatim text and read-only status', async () => {
  const f = fixture()
  await f.call()
  expect(f.requestConnector).toHaveBeenCalledWith(
    {
      text: params.text,
      requestId: 'connector:emp_sal:operation-1',
      source: {
        worktreeId: 'folder:work',
        paneKey: 'connector:emp_sal:operation-1',
        agent: 'codex'
      },
      context: ''
    },
    {
      operator: 'emp_sal',
      digest: 'signed-digest',
      launch,
      nonce: 'e2b79bdd-907a-4f4e-ae34-a5f75c0ad520',
      expiresAt: 1300,
      statusOnly: true
    }
  )
})
it('refuses a workspace assigned to another execution host', async () => {
  const f = fixture('ssh-other')
  await expect(f.call()).rejects.toThrow('workspace owner')
  expect(f.requestConnector).not.toHaveBeenCalled()
})
it('does not fall back to ordinary user authority after connector verification fails', async () => {
  authenticate.mockImplementation(() => {
    throw new Error('signature invalid')
  })
  const f = fixture()
  await expect(f.call()).rejects.toThrow('signature invalid')
  expect(f.requestConnector).not.toHaveBeenCalled()
})
