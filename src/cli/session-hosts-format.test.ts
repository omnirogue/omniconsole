import { describe, expect, it } from 'vitest'
import {
  CROSS_COMPUTER_RELOCATION_UNAVAILABLE,
  type SessionHostsStatusResult
} from '../shared/session-hosts-status'
import { formatSessionHosts } from './session-hosts-format'

const HOST_ID = 'host_c3ad3c23b1ff43a4b4687a6e9dbb6261'

describe('omni session hosts', () => {
  it('prints one line per computer, with its state, counts and a pending switch', () => {
    const result: SessionHostsStatusResult = {
      hosts: [
        {
          hostKey: 'runtime:studio',
          kind: 'runtime',
          state: 'ready',
          hostId: HOST_ID,
          capabilities: [],
          checkedAt: 1,
          counts: {
            total: 12,
            live: 11,
            exited: 1,
            unverifiable: 0,
            working: 3,
            needsYou: 1,
            stalled: 0
          }
        },
        {
          hostKey: 'ssh:build',
          kind: 'ssh',
          state: 'unreachable',
          capabilities: [],
          checkedAt: 1,
          counts: null
        }
      ],
      refreshing: false,
      switches: [{ hostId: HOST_ID, automation: 'off', at: 1, state: 'pending', setHere: true }],
      folderPolicies: {},
      thisHostOffElsewhere: true
    }
    expect(formatSessionHosts(result).split('\n')).toEqual([
      `runtime:studio (runtime): carries out session controls · 12 sessions, 3 working, 1 need you, 1 exited · ${CROSS_COMPUTER_RELOCATION_UNAVAILABLE} · automatic actions off (pending: it has not confirmed)`,
      'ssh:build (ssh): unreachable: its sessions are left alone',
      'Another Mac switched automatic actions off on this computer.'
    ])
  })

  it('says which computers take moved conversations, and keeps the not-available words for the rest', () => {
    const host = (
      hostKey: string,
      capabilities: string[],
      kind: 'runtime' | 'ssh' = 'runtime'
    ) => ({
      hostKey,
      kind,
      state: 'ready' as const,
      capabilities,
      checkedAt: 1,
      counts: null
    })
    const result: SessionHostsStatusResult = {
      hosts: [
        host('runtime:laptop', [
          'session-control.owner.v1',
          'session-relocation.claude.v1',
          'session-relocation.codex.v1',
          'session-relocation.bundle.v1'
        ]),
        // A build that relocates but cannot move bundles cannot take a moved conversation.
        host('runtime:mini', ['session-control.owner.v1', 'session-relocation.claude.v1']),
        // An SSH host moves its conversations to a Mac but takes none in (package B3).
        host(
          'ssh:box',
          [
            'session-control.owner.v1',
            'session-relocation.claude.v1',
            'session-relocation.codex.v1',
            'session-relocation.bundle.v1'
          ],
          'ssh'
        )
      ],
      refreshing: false,
      switches: [],
      folderPolicies: {},
      thisHostOffElsewhere: false
    }
    expect(formatSessionHosts(result).split('\n')).toEqual([
      'runtime:laptop (runtime): carries out session controls · takes moved conversations (claude, codex; omni session relocate)',
      `runtime:mini (runtime): carries out session controls · ${CROSS_COMPUTER_RELOCATION_UNAVAILABLE}`,
      'ssh:box (ssh): carries out session controls · moves its conversations to a Mac (claude, codex; omni session relocate)'
    ])
  })

  // Session parity (G2): what this Mac knows of each paired owner's conversation ledger.
  it("names each paired owner's ledger state beside its controls, and nothing for an older one", () => {
    const owner = (
      hostKey: string,
      ledger?: NonNullable<SessionHostsStatusResult['hosts'][number]['ledger']>
    ) => ({
      hostKey,
      kind: 'runtime' as const,
      state: 'controls-off' as const,
      capabilities: [],
      checkedAt: 1,
      counts: null,
      ...(ledger ? { ledger } : {})
    })
    const asOf = Date.UTC(2026, 9, 6, 21, 30, 0)
    const lines = formatSessionHosts({
      hosts: [
        owner('runtime:studio', {
          hostId: 'runtime:studio',
          generation: 'gen-1',
          revision: 7,
          source: 'window',
          state: 'ready',
          asOf
        }),
        owner('runtime:mini', {
          hostId: 'runtime:mini',
          generation: 'gen-2',
          revision: 2,
          source: 'main',
          state: 'unreachable',
          asOf
        }),
        owner('runtime:old', {
          hostId: 'runtime:old',
          generation: null,
          revision: null,
          source: null,
          state: 'older',
          asOf: null
        }),
        owner('runtime:never')
      ],
      refreshing: false,
      switches: [],
      folderPolicies: {},
      thisHostOffElsewhere: false
    }).split('\n')
    expect(lines).toEqual([
      'runtime:studio (runtime): offers no session controls · ledger ready (revision 7, window-authored)',
      'runtime:mini (runtime): offers no session controls · ledger unreachable, last listed 2026-10-06T21:30:00.000Z',
      'runtime:old (runtime): offers no session controls · older OmniConsole: paused and archived conversations not listed',
      'runtime:never (runtime): offers no session controls'
    ])
  })
})
