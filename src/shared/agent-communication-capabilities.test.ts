import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AGENT_COMMUNICATION_CHANNEL_KINDS,
  parseAgentCommunicationCapabilities,
  readAgentCommunicationCapabilities
} from './agent-communication-capabilities'

type Lock = { commit: string; files: Record<string, string> }
type Fixture = { name: string; valid: boolean; input: unknown }

const CONTRACTS = join(__dirname, 'contracts')
const PINNED = join(CONTRACTS, 'agent-communication-v1')
const lock = JSON.parse(
  readFileSync(join(CONTRACTS, 'agent-communication.lock.json'), 'utf8')
) as Lock
const fixtures = JSON.parse(
  readFileSync(join(PINNED, 'agent-communication-v1.fixtures.json'), 'utf8')
) as { fixture_version: number; cases: Fixture[] }

function fixture(name: string): Fixture {
  const found = fixtures.cases.find((entry) => entry.name === name)
  if (!found) {
    throw new Error(`Missing shared fixture ${name}`)
  }
  return found
}

describe('pinned agent-communication-v1 contract', () => {
  it('holds exactly the bytes its lock names', () => {
    expect(Object.keys(lock.files).sort()).toEqual([
      'agent-communication-v1.fixtures.json',
      'agent-communication-v1.md',
      'agent-communication-v1.schema.json'
    ])
    expect(lock.commit).toMatch(/^[0-9a-f]{40}$/)
    for (const [name, sha256] of Object.entries(lock.files)) {
      const digest = createHash('sha256')
        .update(readFileSync(join(PINNED, name)))
        .digest('hex')
      expect(digest, name).toBe(sha256)
    }
  })
})

describe('parseAgentCommunicationCapabilities', () => {
  it('uses the shared fixture format', () => {
    expect(fixtures.fixture_version).toBe(1)
    expect(fixtures.cases.some((entry) => entry.valid)).toBe(true)
    expect(fixtures.cases.some((entry) => !entry.valid)).toBe(true)
  })

  it.each(fixtures.cases.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    expect(parseAgentCommunicationCapabilities(entry.input).status).toBe(
      entry.valid ? 'valid' : 'unknown'
    )
  })

  it('selects channels by kind, whatever their order', () => {
    const document = fixture('hub_explicit_inbox_only').input as { channels: unknown[] }
    const result = parseAgentCommunicationCapabilities({
      ...document,
      channels: document.channels.toReversed()
    })
    if (result.status !== 'valid') {
      throw new Error('Expected the reordered hub document to stay valid')
    }
    expect(Object.keys(result.channels).sort()).toEqual(
      [...AGENT_COMMUNICATION_CHANNEL_KINDS].sort()
    )
    expect(result.channels.agent_exchange).toMatchObject({
      receive_mode: 'explicit_pull',
      wake_mode: 'none',
      model_ack: false
    })
  })

  it('reads the communication property of a hub pending answer and nothing else', () => {
    const communication = fixture('hub_explicit_inbox_only').input
    const counts = { schema_version: 1, pending: 0, available: 0, leased: 0, blocked: 0 }
    expect(readAgentCommunicationCapabilities({ ...counts, communication }).status).toBe('valid')
    expect(readAgentCommunicationCapabilities(counts).status).toBe('unknown')
    expect(readAgentCommunicationCapabilities(communication).status).toBe('unknown')
    expect(readAgentCommunicationCapabilities(null).status).toBe('unknown')
  })
})
