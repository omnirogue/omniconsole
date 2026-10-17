import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import { countProtectedCredentialSites } from './transcript-protected-credentials'
import { isKnownNonSecretPair } from './transcript-labeled-value'

function text(value: string): NativeChatMessage {
  return {
    id: 'm',
    role: 'assistant',
    blocks: [{ type: 'text', text: value }],
    timestamp: 0,
    source: 'transcript'
  } as NativeChatMessage
}

describe('labeled values in text', () => {
  it('accepts ordinary source text: interfaces, env lookups, docs, placeholders', () => {
    const accepted = [
      'interface Auth {\n  token: string\n  secret?: string\n  password: string | null;\n}',
      'const apiKey = process.env.OPENAI_API_KEY',
      'apiKey: process.env.X,',
      'password: null,',
      'token: undefined',
      'api_key: ${OPENAI_API_KEY}',
      'OPENAI_API_KEY=<your-key-here>',
      'password: "example"',
      'token: "***"',
      'Set the password field, then rotate the token later.',
      'access_token: true',
      'client_secret: $CLIENT_SECRET',
      'refresh_token: os.environ["REFRESH"]',
      'secret: "..."',
      "credentials: 'omit',",
      "credentials: 'include'",
      'credentials: "same-origin"',
      'PWD=/Users/x/Work/OmniRogue',
      'token_type: "Bearer"',
      'tokenType: MAC',
      'secretName: db-credentials',
      'secretKeyRef: my-app-secrets',
      'input_tokens: 12345',
      'max_tokens: 4096, output_tokens: 8192',
      'tokens_used=123456',
      'PWD=/Users/x/Work/OmniRogue',
      'pwd: ~/Work',
      'pwd: ./build',
      'pwd: ../repo',
      'PWD=.',
      'PWD=~',
      'Pwd=C:\\Users\\x',
      'cookieMaxAge: 86400',
      'SESSION_COOKIE_AGE=1209600',
      'PASSWORD_RESET_TIMEOUT = 259200',
      'token_ttl: 3600s',
      'access_token_lifetime: 900',
      'refresh_token_expiry: 2592000',
      'auth_cookie_max_age: 3600'
    ]
    for (const sample of accepted) {
      expect(countProtectedCredentialSites([text(sample)]), sample).toBe(0)
    }
  })

  it('refuses real credentials beside a label', () => {
    const refused = [
      'password: "hunter2-9x"',
      'OPENAI_API_KEY=sk-proj-abcdefghijklmnop',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0',
      '"database_password": "pg-4829-secret"',
      "export STRIPE_SECRET_KEY='sk_live_1234567890'",
      'token: abcd1234efgh',
      'password: 482913',
      'credentials: "hunter2-9x"',
      'token_type: sk-proj-abcdefgh',
      'api_key: 1234567890',
      'Pwd=P@ssw0rd123',
      'pwd:482913',
      'pwd=.actualSecret9',
      'pwd=~actualSecret9',
      'PWD=..actualSecret9',
      // The label sits inside a quoted shell argument: the close quote is not after it.
      `curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0" https://x`,
      // Prose with an unbalanced quote before the label.
      `he said "the password: hunter2-9x works`,
      'token_ttl: sk-proj-abcdefgh',
      'cookieMaxAge: "hunter2-9x"'
    ]
    for (const sample of refused) {
      expect(countProtectedCredentialSites([text(sample)]), sample).toBe(1)
    }
  })

  it('scans a megabyte of hostile label-shaped text in linear time', () => {
    const hostile = `${'-'.repeat(1_400_000)}token`
    const started = performance.now()
    expect(countProtectedCredentialSites([text(hostile), text('password-'.repeat(100_000))])).toBe(
      0
    )
    expect(performance.now() - started).toBeLessThan(2_000)
  })

  it('applies the exact non-secret pairs to structured tool inputs too', () => {
    const call = (input: unknown): NativeChatMessage =>
      ({
        id: 'm',
        role: 'assistant',
        blocks: [{ type: 'tool-call', name: 'fetch', input }],
        timestamp: 0,
        source: 'transcript'
      }) as NativeChatMessage
    expect(
      countProtectedCredentialSites([
        call({ credentials: 'omit', token_type: 'Bearer', input_tokens: 12, secretName: 'db' })
      ])
    ).toBe(0)
    expect(countProtectedCredentialSites([call({ credentials: 'hunter2-9x' })])).toBe(1)
    expect(countProtectedCredentialSites([call({ password: 482913 })])).toBe(1)
    // A nested credential under an exempt reference label is still found.
    expect(
      countProtectedCredentialSites([
        call({ secretKeyRef: { name: 'db', key: 'pw', password: 'hunter2-9x' } })
      ])
    ).toBe(1)
    expect(countProtectedCredentialSites([call({ secretKeyRef: { name: 'db', key: 'pw' } })])).toBe(
      0
    )
    expect(countProtectedCredentialSites([call({ PWD: '/Users/x', pwd: 'P@ssw0rd123' })])).toBe(1)
    // A protected parent holding an object counts once (and its children are still walked).
    expect(countProtectedCredentialSites([call({ password: { value: 'actualSecret9' } })])).toBe(1)
    expect(countProtectedCredentialSites([call({ token: { value: 'x' } })])).toBe(1)
    expect(
      countProtectedCredentialSites([call({ token: { value: 'x', password: 'hunter2-9x' } })])
    ).toBe(2)
    expect(isKnownNonSecretPair('Credentials', "'same-origin'")).toBe(true)
    expect(isKnownNonSecretPair('credentials', 'omitted-not-a-policy')).toBe(false)
  })
})
