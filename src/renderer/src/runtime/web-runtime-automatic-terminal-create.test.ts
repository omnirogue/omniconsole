// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  beginWebRuntimeAutomaticTerminalCreate,
  observeWebRuntimeAutomaticTerminalCreate,
  resetWebRuntimeAutomaticTerminalCreatesForTests
} from './web-runtime-automatic-terminal-create'

const owner = { environmentId: 'owner-a', pairingRevision: 1 }

describe('automatic remote terminal creation', () => {
  beforeEach(() => resetWebRuntimeAutomaticTerminalCreatesForTests())
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    resetWebRuntimeAutomaticTerminalCreatesForTests()
  })

  it('keeps pending creation held even when its host publication arrives first', () => {
    const operation = beginWebRuntimeAutomaticTerminalCreate(owner, 'worktree-a')!
    operation.onSessionCreated('host-created')
    observeWebRuntimeAutomaticTerminalCreate(owner, 'worktree-a', ['host-created'])
    expect(beginWebRuntimeAutomaticTerminalCreate(owner, 'worktree-a')).toBeNull()
    operation.finish({ status: 'created' })
    expect(beginWebRuntimeAutomaticTerminalCreate(owner, 'worktree-a')).not.toBeNull()
  })

  it.each([
    { status: 'created' as const },
    { status: 'failed' as const, message: 'Lost receipt', creationUnverifiable: true as const }
  ])('waits for host publication after a $status create receipt', (outcome) => {
    const operation = beginWebRuntimeAutomaticTerminalCreate(owner, 'worktree-a')!
    operation.onSessionCreated('host-created')
    operation.finish(outcome)
    expect(beginWebRuntimeAutomaticTerminalCreate(owner, 'worktree-a')).toBeNull()
    observeWebRuntimeAutomaticTerminalCreate(owner, 'worktree-a', ['host-created'])
    expect(beginWebRuntimeAutomaticTerminalCreate(owner, 'worktree-a')).not.toBeNull()
  })

  it('does not settle a lost receipt from an unrelated terminal publication', () => {
    const operation = beginWebRuntimeAutomaticTerminalCreate(owner, 'worktree-a')!
    operation.finish({ status: 'failed', message: 'Lost receipt', creationUnverifiable: true })
    observeWebRuntimeAutomaticTerminalCreate(owner, 'worktree-a', ['manual-terminal'])
    expect(beginWebRuntimeAutomaticTerminalCreate(owner, 'worktree-a')).toBeNull()
  })

  it('releases a definitive refusal and allocates a distinct retry identity', () => {
    const refused = beginWebRuntimeAutomaticTerminalCreate(owner, 'worktree-a')!
    refused.finish({ status: 'failed', message: 'Workspace not found' })
    const retry = beginWebRuntimeAutomaticTerminalCreate(owner, 'worktree-a')!
    expect(retry.clientMutationId).not.toBe(refused.clientMutationId)
  })

  it('scopes holds to the paired owner and the workspace, including folders', () => {
    beginWebRuntimeAutomaticTerminalCreate(owner, 'folder:workspace-a')
    expect(beginWebRuntimeAutomaticTerminalCreate(owner, 'folder:workspace-a')).toBeNull()
    expect(
      beginWebRuntimeAutomaticTerminalCreate(
        { environmentId: 'owner-b', pairingRevision: 1 },
        'folder:workspace-a'
      )
    ).not.toBeNull()
    expect(
      beginWebRuntimeAutomaticTerminalCreate({ ...owner, pairingRevision: 2 }, 'folder:workspace-a')
    ).not.toBeNull()
    expect(beginWebRuntimeAutomaticTerminalCreate(owner, 'folder:workspace-b')).not.toBeNull()
  })

  it('does not let a stale completion release a successor operation', () => {
    const stale = beginWebRuntimeAutomaticTerminalCreate(owner, 'worktree-a')!
    resetWebRuntimeAutomaticTerminalCreatesForTests()
    beginWebRuntimeAutomaticTerminalCreate(owner, 'worktree-a')
    stale.finish({ status: 'failed', message: 'Old refusal' })
    expect(beginWebRuntimeAutomaticTerminalCreate(owner, 'worktree-a')).toBeNull()
  })

  it('rehydrates an unconfirmed create after its renderer module reloads', async () => {
    const operation = beginWebRuntimeAutomaticTerminalCreate(owner, 'worktree-a')!
    const saved = window.sessionStorage.getItem(window.sessionStorage.key(0)!)!
    expect(JSON.parse(saved).clientMutationId).toBe(operation.clientMutationId)
    vi.resetModules()
    const reloaded = await import('./web-runtime-automatic-terminal-create')
    expect(reloaded.beginWebRuntimeAutomaticTerminalCreate(owner, 'worktree-a')).toBeNull()
    reloaded.observeWebRuntimeAutomaticTerminalCreate(owner, 'worktree-a', ['manual-terminal'])
    expect(reloaded.beginWebRuntimeAutomaticTerminalCreate(owner, 'worktree-a')).toBeNull()
    expect(window.sessionStorage.getItem(window.sessionStorage.key(0)!)).toBe(saved)
  })

  it('settles a reloaded hold only when its returned host tab is observed', async () => {
    const operation = beginWebRuntimeAutomaticTerminalCreate(owner, 'worktree-a')!
    operation.onSessionCreated('web-terminal-host-created%3A%3Aleaf-1')
    operation.finish({ status: 'created' })
    vi.resetModules()
    const reloaded = await import('./web-runtime-automatic-terminal-create')
    reloaded.observeWebRuntimeAutomaticTerminalCreate(owner, 'worktree-a', ['unrelated-tab'])
    expect(reloaded.beginWebRuntimeAutomaticTerminalCreate(owner, 'worktree-a')).toBeNull()
    reloaded.observeWebRuntimeAutomaticTerminalCreate(owner, 'worktree-a', ['host-created::leaf-1'])
    const successor = reloaded.beginWebRuntimeAutomaticTerminalCreate(owner, 'worktree-a')!
    expect(successor.clientMutationId).not.toBe(operation.clientMutationId)
  })

  it('clears the persisted hold after a definitive refusal', async () => {
    const operation = beginWebRuntimeAutomaticTerminalCreate(owner, 'worktree-a')!
    operation.finish({ status: 'failed', message: 'Invalid argument' })
    expect(window.sessionStorage.length).toBe(0)
    vi.resetModules()
    const reloaded = await import('./web-runtime-automatic-terminal-create')
    expect(reloaded.beginWebRuntimeAutomaticTerminalCreate(owner, 'worktree-a')).not.toBeNull()
  })

  it.each(['unavailable', 'throws'])(
    'keeps the memory hold when tab storage $0',
    (availability) => {
      if (availability === 'unavailable') {
        vi.stubGlobal('window', undefined)
      } else {
        vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
          throw new Error('Storage denied')
        })
      }
      const operation = beginWebRuntimeAutomaticTerminalCreate(owner, 'worktree-a')!
      expect(beginWebRuntimeAutomaticTerminalCreate(owner, 'worktree-a')).toBeNull()
      operation.finish({ status: 'failed', message: 'Refused before spawn' })
      expect(beginWebRuntimeAutomaticTerminalCreate(owner, 'worktree-a')).not.toBeNull()
    }
  )
})
