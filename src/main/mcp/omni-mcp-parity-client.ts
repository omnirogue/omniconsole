import { OMNISI_MCP_URL } from '../../shared/omni-console-mcp-ledger-headers'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'
import {
  type JsonObject,
  type OmniMcpAccessBulk,
  type OmniMcpDecision,
  type OmniMcpInvoke,
  type OmniMcpParityClientOptions,
  OmniMcpParityError,
  type OmniMcpSession,
  type OmniMcpSurvey,
  type OmniMcpToolResult,
  present,
  readRpc,
  record,
  requireValue,
  type Scope
} from './omni-mcp-parity-rpc'

export {
  type OmniMcpAccessBulk,
  type OmniMcpDecision,
  type OmniMcpInvoke,
  type OmniMcpParityClientOptions,
  OmniMcpParityError,
  type OmniMcpSession,
  type OmniMcpSurvey,
  type OmniMcpToolResult
}

/** Main-process only: the caller leases a WorkOS token for OMNISI_MCP_URL, never a provider secret. */
export class OmniMcpParityClient {
  constructor(private readonly options: OmniMcpParityClientOptions) {
    requireValue(present(options.organizationId), 'organization_required')
    const timeout = options.timeoutMs ?? 30_000
    requireValue(
      Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 120_000,
      'invalid_timeout'
    )
    this.options = { ...options }
  }

  capabilities(args: Scope & { query?: string; limit?: number } = {}): Promise<OmniMcpToolResult> {
    return this.call('capabilities', args)
  }

  invoke(args: OmniMcpInvoke): Promise<OmniMcpToolResult> {
    requireValue(present(args.capability), 'capability_required')
    if (args.method && args.method !== 'GET' && !args.dry_run) {
      requireValue(present(args.request_id), 'request_id_required')
    }
    return this.call('invoke', args)
  }

  explainAccess(args: Scope & { capability: string }): Promise<OmniMcpToolResult> {
    requireValue(present(args.capability), 'capability_required')
    return this.call('explain_access', args)
  }

  setAccessBulk(args: OmniMcpAccessBulk): Promise<OmniMcpToolResult> {
    requireValue(
      present(args.expected_digest) && present(args.reason),
      'access_revision_and_reason_required'
    )
    requireValue(
      [args.changes, args.template, args.column].filter((v) => v !== undefined).length === 1,
      'access_mode_required'
    )
    if (args.changes) {
      requireValue(args.changes.length > 0 && args.changes.length <= 500, 'invalid_access_changes')
    }
    return this.call('set_access_bulk', args)
  }

  dispatchDecision(args: OmniMcpDecision): Promise<OmniMcpToolResult> {
    requireValue(args.options.length >= 2, 'decision_options_required')
    if (args.recommended !== undefined) {
      requireValue(
        Number.isInteger(args.recommended) &&
          args.recommended >= 1 &&
          args.recommended <= args.options.length,
        'invalid_recommendation'
      )
    }
    return this.dispatch('decision', args)
  }

  dispatchSurvey(args: OmniMcpSurvey): Promise<OmniMcpToolResult> {
    requireValue(args.form.length > 0, 'survey_form_required')
    return this.dispatch('review', args)
  }

  peerSend(args: {
    to: string
    text: string
    idempotency_key: string
    purpose?: 'question' | 'status' | 'dependency'
    references?: string[]
  }): Promise<OmniMcpToolResult> {
    requireValue(
      present(args.to) && present(args.text) && present(args.idempotency_key),
      'peer_message_required'
    )
    requireValue(!args.references || args.references.length <= 4, 'too_many_references')
    return this.call('peer_send', args)
  }

  peerPending(): Promise<OmniMcpToolResult> {
    return this.call('peer_pending', {})
  }

  peerInbox(limit?: number): Promise<OmniMcpToolResult> {
    requireValue(limit === undefined || (Number.isSafeInteger(limit) && limit > 0), 'invalid_limit')
    return this.call('peer_inbox', limit === undefined ? {} : { limit })
  }

  peerAck(args: { message_id: string; lease_token: string }): Promise<OmniMcpToolResult> {
    requireValue(present(args.message_id) && present(args.lease_token), 'peer_lease_required')
    return this.call('peer_ack', args)
  }

  private dispatch(
    type: 'decision' | 'review',
    args: OmniMcpDecision | OmniMcpSurvey
  ): Promise<OmniMcpToolResult> {
    requireValue(args.people.length > 0 && args.people.every(present), 'recipients_required')
    requireValue(
      present(args.question) && present(args.idempotency_key),
      'question_and_key_required'
    )
    const people = [...new Set(args.people)]
    if (present(args.artifact_id)) {
      return this.call('artifact_ask', { ...args, type, people })
    }
    if (type === 'decision' && people.length === 1) {
      return this.call('decision_ask_one', { ...args, people, to: people[0] })
    }
    return this.call('decision_ask_many', {
      ...args,
      people,
      to: people,
      mode: type === 'review' ? 'each' : 'any'
    })
  }

  private async call(name: string, args: JsonObject): Promise<OmniMcpToolResult> {
    const signal = AbortSignal.timeout(this.options.timeoutMs ?? 30_000)
    const argumentsSnapshot: unknown = JSON.parse(JSON.stringify(args))
    let onAbort = (): void => {}
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
    })
    const session = await Promise.race([
      Promise.resolve().then(() => this.options.getSession(signal)),
      aborted
    ]).finally(() => signal.removeEventListener('abort', onAbort))
    signal.throwIfAborted()
    requireValue(session && present(session.accessToken), 'sign_in_required')
    requireValue(session.organizationId === this.options.organizationId, 'organization_mismatch')
    const headers: Record<string, string> = {
      Authorization: `Bearer ${session.accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream'
    }
    const post = async (body: JsonObject): Promise<Response> => {
      signal.throwIfAborted()
      session.assertCurrent()
      const response = await (this.options.fetcher ?? fetch)(OMNISI_MCP_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer'
      })
      try {
        session.assertCurrent()
        requireValue(
          response.ok && !response.redirected && (!response.url || response.url === OMNISI_MCP_URL),
          `http_${response.status}`
        )
        return response
      } catch (error) {
        await cancelUnreadResponseBody(response)
        throw error
      }
    }
    // A fresh handshake binds each call to this account; uncertain writes are never replayed.
    const initResponse = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'omni-mcp-parity-client', version: '1.0.0' }
      }
    })
    const init = await readRpc(initResponse, 1)
    requireValue(
      ['2025-03-26', '2025-06-18'].includes(String(init.protocolVersion)) &&
        record(init.capabilities).tools,
      'unsupported_server'
    )
    headers['MCP-Protocol-Version'] = String(init.protocolVersion)
    const sessionId = initResponse.headers.get('mcp-session-id')
    if (sessionId) {
      headers['Mcp-Session-Id'] = sessionId
    }
    await cancelUnreadResponseBody(
      await post({ jsonrpc: '2.0', method: 'notifications/initialized' })
    )
    const result = await readRpc(
      await post({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name, arguments: argumentsSnapshot }
      }),
      2
    )
    session.assertCurrent()
    requireValue(
      Array.isArray(result.content) && result.content.every((item) => present(record(item).type)),
      'invalid_tool_result'
    )
    requireValue(
      result.isError === undefined || typeof result.isError === 'boolean',
      'invalid_tool_result'
    )
    requireValue(
      result.structuredContent === undefined ||
        record(result.structuredContent) === result.structuredContent,
      'invalid_tool_result'
    )
    if (result.isError) {
      throw new OmniMcpParityError('tool_error', result)
    }
    return result as OmniMcpToolResult
  }
}
