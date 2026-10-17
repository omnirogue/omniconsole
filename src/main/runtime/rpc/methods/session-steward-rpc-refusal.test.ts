// D4: the steward is a new authority path, so no RPC caller may claim it. Every method that
// changes sessions is checked through the params schema its dispatcher actually validates with.

import { describe, expect, it, vi } from 'vitest'
import { SESSION_FOLDERS_RPC } from '../../../../shared/session-folder-cli'
import { SESSION_MANAGE_RPC } from '../../../../shared/session-manage-types'
import { SESSION_ORGANIZATION_RPC } from '../../../../shared/session-organization-change'
import { OrganizationExecutorSchema } from '../../../../shared/session-organization-change-schema'
import { SESSION_STEWARD_RPC } from '../../../../shared/session-steward-suggestions'
import type { RpcMethod } from '../core'

vi.mock('../../../omni-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => '/nonexistent'
}))

const { SESSION_ORGANIZATION_METHODS } = await import('./session-organization')
const { SESSION_FOLDER_METHODS } = await import('./session-folders')
const { SESSION_ORGANIZE_METHOD } = await import('./session-organization-organize')
const { SESSION_MANAGE_METHODS } = await import('./session-manage')
const { SESSION_MANAGE_REUSE_METHODS } = await import('./session-manage-reuse-methods')
const { SESSION_STEWARD_SUGGESTION_METHODS } = await import('./session-steward-suggestions')

const METHODS: RpcMethod[] = [
  ...SESSION_ORGANIZATION_METHODS,
  ...SESSION_FOLDER_METHODS,
  SESSION_ORGANIZE_METHOD,
  ...SESSION_MANAGE_METHODS,
  ...SESSION_MANAGE_REUSE_METHODS,
  ...SESSION_STEWARD_SUGGESTION_METHODS
]

function accepts(name: string, params: unknown): boolean {
  const method = METHODS.find((entry) => entry.name === name)
  if (!method?.params) {
    throw new Error(`no params schema for ${name}`)
  }
  return method.params.safeParse(params).success
}

const STEWARD_EXECUTOR = { kind: 'app', feature: 'steward' }
const CLAIMS = [
  { actor: { kind: 'steward', feature: 'rules' } },
  { actor: { kind: 'steward', feature: 'cleanup-run', runId: 'run-1' } },
  { actor: { kind: 'steward', feature: 'suggestion', suggestionId: 'sg-1' } },
  { executor: STEWARD_EXECUTOR },
  { steward: { feature: 'rules' } },
  { steward: { feature: 'suggestion', suggestionId: 'sg-1' } },
  { unattended: null }
]

const target = { paneKey: 'tab-1:leaf-1' }
const CALLS: [string, Record<string, unknown>][] = [
  [SESSION_MANAGE_RPC.continue, { target, answer: { kind: 'yes' } }],
  [SESSION_MANAGE_RPC.ask, { target, question: 'Is your task complete?' }],
  [SESSION_MANAGE_RPC.stop, { target }],
  [SESSION_MANAGE_RPC.restart, { target }],
  [SESSION_MANAGE_RPC.rename, { target, title: 'Checkout fix' }],
  [SESSION_MANAGE_RPC.tidy, { apply: true, request: 'clean up' }],
  [SESSION_MANAGE_RPC.handoff, { target, to: 'new' }],
  [SESSION_MANAGE_RPC.consolidate, { panes: ['tab-1:leaf-1', 'tab-2:leaf-1'], into: 'new' }],
  [SESSION_MANAGE_RPC.assign, { target, task: 'Add tests', reason: 'free and related' }],
  [SESSION_MANAGE_RPC.resume, { ref: 'claude:abc123' }],
  [SESSION_MANAGE_RPC.continueWhenIdle, { target, text: 'Carry on when free.' }],
  [
    SESSION_MANAGE_RPC.answer,
    { target: { paneKey: 'tab-1:leaf-1' }, expect: 'a'.repeat(64), answer: { kind: 'allow' } }
  ],
  [SESSION_FOLDERS_RPC.mutate, { op: { kind: 'archiveSession', ...target, archived: true } }],
  [
    SESSION_ORGANIZATION_RPC.organize,
    { plan: { changes: [{ pane: 'tab-1:leaf-1', archive: true }] } }
  ],
  [SESSION_STEWARD_RPC.acceptSuggestion, { id: 'sg-1' }],
  [SESSION_STEWARD_RPC.dismissSuggestion, { id: 'sg-1' }],
  [SESSION_STEWARD_RPC.resumeOrganize, { feature: 'refile' }]
]

describe('no RPC caller can claim the steward', () => {
  it.each(CALLS)('%s refuses a steward actor, executor or unattended claim', (name, params) => {
    expect(accepts(name, params)).toBe(true)
    for (const claim of CLAIMS) {
      expect(accepts(name, { ...params, ...claim })).toBe(false)
    }
  })

  it('refuses a steward executor on the window’s own records, which still take the app’s others', () => {
    const change = {
      opId: 'op-1',
      kind: 'archive',
      targets: [{ sessionKey: 'k1' }],
      value: true
    }
    for (const name of [SESSION_ORGANIZATION_RPC.prepare, SESSION_ORGANIZATION_RPC.settle]) {
      const phase = name === SESSION_ORGANIZATION_RPC.settle ? { phase: 'applied' } : {}
      expect(
        accepts(name, {
          ...phase,
          change: { ...change, executor: { kind: 'app', feature: 'auto-archive' } }
        })
      ).toBe(true)
      expect(accepts(name, { ...phase, change: { ...change, executor: STEWARD_EXECUTOR } })).toBe(
        false
      )
      expect(
        accepts(name, { ...phase, change: { ...change, executor: { kind: 'steward' } } })
      ).toBe(false)
    }
    expect(OrganizationExecutorSchema.safeParse(STEWARD_EXECUTOR).success).toBe(false)
  })
})
