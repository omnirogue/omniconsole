import { createHash, createPublicKey, verify } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { SessionPrepConnector } from '../../shared/session-prep-connector'
import { sessionPrepConnectorTextSchema } from '../../shared/session-prep-connector'
import type { RpcContext } from '../runtime/rpc/core'
import { readPrivateManagedFile } from '../runtime/managed-session-tools-files'

const claimsSchema = z
  .object({
    v: z.literal(1),
    aud: z.literal('session-prep'),
    raw: z.literal(false),
    purpose: z.enum(['launch', 'status']),
    nonce: z.string().uuid(),
    operator: z.enum(['emp_sal', 'emp_eve', 'emp_uma']),
    requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{7,95}$/),
    text: sessionPrepConnectorTextSchema,
    workspace: z.string().min(1).max(500),
    title: z.string().min(1).max(160),
    executionHost: z.string().min(1).max(80),
    issuedAt: z.number().int(),
    expiresAt: z.number().int(),
    provider: z.enum(['claude', 'codex', 'gemini']).optional(),
    model: z.string().min(1).max(80).optional(),
    effort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']).optional()
  })
  .strict()

type Config = { execution_host: string; state_dir: string; workspace_roots: string[] }
type Dependencies = {
  publicKey: string
  config: Config
  now: number
  realpath: (path: string) => string
  descriptor: (file: string) => unknown
}

function publicVerificationKey(pem: string) {
  // createPublicKey also accepts private PEMs; the execution host must hold only a verifier.
  if (
    !/^-----BEGIN PUBLIC KEY-----[\r\n]+[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----$/.test(
      pem.trim()
    )
  ) {
    throw new Error('Connector verification requires public PEM key material only.')
  }
  return createPublicKey(pem)
}

export function readSessionPrepVerificationKey(file: string, home = homedir()): string {
  const pem = readPrivateManagedFile(file, home).toString('utf8')
  publicVerificationKey(pem)
  return pem
}

function configuredDependencies(): Dependencies {
  const home = homedir()
  const keyFile =
    process.env.OMNI_SESSION_PREP_VERIFY_KEY_FILE ??
    join(home, '.config', 'omni', 'session-prep-verify.pem')
  if (!keyFile) {
    throw new Error('Connector session prep verification is not configured.')
  }
  return {
    publicKey: readSessionPrepVerificationKey(keyFile, home),
    config: JSON.parse(
      readPrivateManagedFile(join(home, '.config/omni/ai-operations-host.json'), home).toString()
    ),
    now: Math.floor(Date.now() / 1000),
    realpath: realpathSync,
    descriptor: (file) => JSON.parse(readPrivateManagedFile(file, home).toString())
  }
}

/** Native caller identity grants no authority; only a BFF-signed operator assertion does. */
export function authenticateSessionPrepConnector(
  connector: SessionPrepConnector,
  text: string,
  context: Pick<
    RpcContext,
    'orchestrationCapability' | 'orchestrationCompatibilityEvidence' | 'unattendedCaller'
  >,
  deps?: Dependencies
) {
  if (
    context.orchestrationCapability ||
    context.orchestrationCompatibilityEvidence ||
    context.unattendedCaller
  ) {
    throw new Error('Agents and workers cannot start connector session prep.')
  }
  const trusted = deps ?? configuredDependencies()
  const key = publicVerificationKey(trusted.publicKey)
  if (
    key.asymmetricKeyType !== 'ed25519' ||
    !verify(
      null,
      Buffer.from(connector.payload),
      key,
      Buffer.from(connector.signature, 'base64url')
    )
  ) {
    throw new Error('Connector session prep signature is invalid.')
  }
  const claims = claimsSchema.parse(
    JSON.parse(Buffer.from(connector.payload, 'base64url').toString('utf8'))
  )
  if (
    claims.text !== text ||
    claims.purpose !== (connector.statusOnly ? 'status' : 'launch') ||
    claims.executionHost !== trusted.config.execution_host ||
    claims.issuedAt > trusted.now + 30 ||
    claims.expiresAt <= trusted.now ||
    claims.expiresAt <= claims.issuedAt ||
    claims.expiresAt > claims.issuedAt + 300
  ) {
    throw new Error('Connector session prep request binding is invalid.')
  }
  for (const field of ['title', 'provider', 'model', 'effort'] as const) {
    if (connector.launch[field] !== claims[field]) {
      throw new Error('Connector launch choice differs from the signed request.')
    }
  }
  if (claims.effort === 'minimal' || claims.effort === 'ultra') {
    throw new Error('This effort is not supported by session prep; use an explicit raw launch.')
  }
  const workspace = trusted.realpath(
    claims.workspace.startsWith('~/')
      ? join(homedir(), claims.workspace.slice(2))
      : claims.workspace
  )
  if (
    !trusted.config.workspace_roots.some((root) => {
      const rel = relative(trusted.realpath(root), workspace)
      return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
    })
  ) {
    throw new Error('Connector workspace is outside the configured work roots.')
  }
  const state = trusted.realpath(trusted.config.state_dir)
  if (
    connector.launch.resultsFolder !== join(state, 'session-results', claims.requestId) ||
    connector.launch.managedToolsFile !==
      join(state, 'session-tools', claims.requestId, 'descriptor.json')
  ) {
    throw new Error('Connector launch files differ from the host-owned operation.')
  }
  const descriptor = trusted.descriptor(connector.launch.managedToolsFile) as {
    operation_id?: unknown
    native_operation_id?: unknown
    principal?: { employee_id?: unknown }
  }
  if (
    descriptor.operation_id !== claims.requestId ||
    descriptor.native_operation_id !== connector.launch.nativeOperationId ||
    descriptor.principal?.employee_id !== claims.operator ||
    resolve(workspace) !== workspace
  ) {
    throw new Error('Connector tool authority differs from the signed operator.')
  }
  const {
    issuedAt: _issuedAt,
    expiresAt: _expiresAt,
    nonce: _nonce,
    purpose: _purpose,
    ...request
  } = claims
  return {
    claims,
    workspace,
    digest: createHash('sha256')
      .update(JSON.stringify({ request, launch: connector.launch }))
      .digest('hex')
  }
}
