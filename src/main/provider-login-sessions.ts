import { randomUUID } from 'node:crypto'
import { stripAnsiEscapeSequences } from '../shared/ansi-escape-sequences'
import type { ProviderLoginRequest, ProviderLoginState } from '../shared/provider-login-types'
import type { ProviderLoginInteraction } from './provider-login-interaction'

type Session = {
  owner: string
  requestKey: string
  state: ProviderLoginState
  controller: AbortController
  input: ((code: string) => void) | null
  running: boolean
  expiresAt: number
}

export class ProviderLoginSessions {
  private readonly sessions = new Map<string, Session>()

  constructor(
    private readonly signIn: (
      request: ProviderLoginRequest,
      interaction: ProviderLoginInteraction
    ) => Promise<unknown>
  ) {}

  start(owner: string, request: ProviderLoginRequest): ProviderLoginState {
    const requestKey = JSON.stringify(request)
    for (const [id, session] of this.sessions) {
      if (!session.running && session.expiresAt < Date.now()) {
        this.sessions.delete(id)
      }
      if (session.running && session.state.provider === request.provider) {
        if (session.owner === owner && session.requestKey === requestKey) {
          return { ...session.state }
        }
        throw new Error('A sign-in for this provider is already running on this computer.')
      }
    }
    if (this.sessions.size >= 32) {
      throw new Error('Too many sign-in attempts. Try again shortly.')
    }
    const session: Session = {
      owner,
      requestKey,
      state: { id: randomUUID(), provider: request.provider, status: 'starting' },
      controller: new AbortController(),
      input: null,
      running: true,
      expiresAt: Date.now() + 600_000
    }
    this.sessions.set(session.state.id, session)
    const deadline = setTimeout(() => session.controller.abort(), 240_000)
    deadline.unref()
    void Promise.resolve()
      .then(() =>
        this.signIn(request, {
          signal: session.controller.signal,
          onOutput: (output) => this.readOutput(session, output),
          setInput: (write) => {
            session.input = write
          }
        })
      )
      .then(() => {
        session.state = { id: session.state.id, provider: request.provider, status: 'complete' }
      })
      .catch(() => {
        session.state = {
          id: session.state.id,
          provider: request.provider,
          status: session.controller.signal.aborted ? 'cancelled' : 'error',
          ...(!session.controller.signal.aborted
            ? {
                error:
                  request.provider === 'codex'
                    ? 'Sign-in did not finish. Check that Codex CLI is installed on this computer and device-code login is enabled in your ChatGPT security settings, then retry.'
                    : 'Sign-in did not finish. Check that Claude CLI is installed on this computer, then retry.'
              }
            : {})
        }
      })
      .finally(() => {
        clearTimeout(deadline)
        session.input = null
        session.running = false
        session.expiresAt = Date.now() + 600_000
      })
    return { ...session.state }
  }

  status(owner: string, id: string): ProviderLoginState {
    return { ...this.owned(owner, id).state }
  }

  submitCode(owner: string, id: string, code: string): ProviderLoginState {
    const session = this.owned(owner, id)
    if (!session.running || !session.state.canSubmitCode || !session.input) {
      throw new Error('This sign-in is not waiting for a browser code.')
    }
    if (!/^[A-Za-z0-9_#=.~+/-]{1,4096}$/.test(code)) {
      throw new Error('Invalid sign-in code.')
    }
    session.input(code)
    session.state.canSubmitCode = false
    return { ...session.state }
  }

  cancel(owner: string, id: string): ProviderLoginState {
    const session = this.owned(owner, id)
    if (session.running) {
      session.controller.abort()
    }
    return { ...session.state }
  }

  stop(): void {
    for (const session of this.sessions.values()) {
      session.controller.abort()
    }
  }

  private owned(owner: string, id: string): Session {
    const session = this.sessions.get(id)
    if (
      !session ||
      session.owner !== owner ||
      (!session.running && session.expiresAt < Date.now())
    ) {
      throw new Error('Sign-in session is unavailable. Start a new sign-in.')
    }
    return session
  }

  private readOutput(session: Session, output: string): void {
    if (session.controller.signal.aborted || !session.running) {
      return
    }
    const text = stripAnsiEscapeSequences(output)
    for (const match of text.matchAll(/https:\/\/[^\s<>"']+/g)) {
      let url: URL
      try {
        url = new URL(match[0])
      } catch {
        continue
      }
      if (url.username || url.password || url.port) {
        continue
      }
      const allowed =
        session.state.provider === 'codex'
          ? url.hostname === 'auth.openai.com' && url.pathname === '/codex/device'
          : (url.hostname === 'claude.com' && url.pathname === '/cai/oauth/authorize') ||
            (['claude.ai', 'platform.claude.com', 'console.anthropic.com'].includes(url.hostname) &&
              url.pathname === '/oauth/authorize')
      if (allowed) {
        session.state.authorizationUrl = url.href
        session.state.status = 'waiting'
      }
    }
    if (session.state.provider === 'codex') {
      const code = text.match(/\b[A-Z0-9]{4}-[A-Z0-9]{5}\b|\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/)
      if (code) {
        session.state.userCode = code[0]
      }
    } else if (/paste.{0,40}code/i.test(text) && session.input) {
      session.state.canSubmitCode = true
    }
  }
}
