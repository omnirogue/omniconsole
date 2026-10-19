import { randomUUID } from 'node:crypto'

// Never propagate server response bodies or transport errors: either can echo Authorization.
export class TeamMcpClient {
  private session: string | null = null
  private ready: Promise<void> | null = null
  constructor(
    private readonly server: string,
    private readonly key: string
  ) {}

  async call(
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    this.ready ??= this.initialize(signal).catch(() => {
      this.ready = null
      throw new Error('OmniSI could not connect. Check your server and team key.')
    })
    await this.ready
    const result = await this.request('tools/call', { name: tool, arguments: args }, signal)
    if (result.isError) {
      throw new Error('OmniSI refused the request. Check your team key and permissions.')
    }
    if (result.structuredContent && typeof result.structuredContent === 'object') {
      return result.structuredContent as Record<string, unknown>
    }
    const content = result.content as { type: string; text?: string }[] | undefined
    try {
      const parsed: unknown = JSON.parse(content?.find((part) => part.type === 'text')?.text ?? '')
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Invalid JSON tool result.')
      }
      return parsed as Record<string, unknown>
    } catch {
      throw new Error('OmniSI returned an invalid tool response.')
    }
  }

  async close(): Promise<void> {
    const session = this.session
    this.session = null
    this.ready = null
    if (!session) {
      return
    }
    try {
      const response = await fetch(this.server, {
        method: 'DELETE',
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${this.key}`,
          'Mcp-Session-Id': session,
          'MCP-Protocol-Version': '2025-03-26'
        },
        signal: AbortSignal.timeout(5000)
      })
      await response.body?.cancel()
    } catch {
      /* Session cleanup must never surface credentials from transport errors. */
    }
  }

  private async initialize(signal?: AbortSignal): Promise<void> {
    await this.request(
      'initialize',
      {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'omniconsole-team', version: '1' }
      },
      signal
    )
    await this.request('notifications/initialized', {}, signal, true)
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    notification = false
  ): Promise<Record<string, unknown>> {
    try {
      const response = await fetch(this.server, {
        method: 'POST',
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${this.key}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2025-03-26',
          ...(this.session ? { 'Mcp-Session-Id': this.session } : {})
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          ...(notification ? {} : { id: randomUUID() }),
          method,
          params
        }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(55000)])
          : AbortSignal.timeout(55000)
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error('Non-OK response.')
      }
      this.session = response.headers.get('mcp-session-id') ?? this.session
      if (notification) {
        await response.body?.cancel()
        return {}
      }
      const reader = response.body?.getReader()
      if (!reader) {
        throw new Error('Missing response body.')
      }
      const decoder = new TextDecoder()
      let text = ''
      try {
        while (text.length < 2 * 1024 * 1024) {
          const part = await reader.read()
          text += decoder.decode(part.value, { stream: !part.done }).replace(/\r\n/g, '\n')
          const sse = response.headers.get('content-type')?.includes('text/event-stream')
          const events = sse
            ? text
                .split('\n\n')
                .slice(0, -1)
                .map((event) =>
                  event
                    .split('\n')
                    .filter((line) => line.startsWith('data:'))
                    .map((line) => line.slice(5).trimStart())
                    .join('\n')
                )
                .filter(Boolean)
            : part.done
              ? [text]
              : []
          for (const event of events) {
            const message = JSON.parse(event)
            if (message.error) {
              throw new Error('JSON-RPC error.')
            }
            if (message.result) {
              return message.result
            }
          }
          if (sse && text.includes('\n\n')) {
            text = text.slice(text.lastIndexOf('\n\n') + 2)
          }
          if (part.done) {
            break
          }
        }
      } finally {
        await reader.cancel().catch(() => {})
      }
      throw new Error('No result in response.')
    } catch {
      this.ready = null
      this.session = null
      throw new Error(
        'OmniSI is unavailable or the team key was refused. Check the connection before retrying.'
      )
    }
  }
}
