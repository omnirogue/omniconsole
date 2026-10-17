import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  sessionManageActorTitle,
  sessionManagePromptMarker,
  type SessionManageActor
} from '../../shared/session-manage-types'
import { SESSION_STEWARD_SWITCHES } from '../../shared/session-steward-settings'
import { configureStewardSwitches, stewardFeatureOn } from '../session-steward/steward-switches'
import { resolveSessionManageActor, sessionManageActorId } from './session-manage-caller'
import { SessionManageRefusal } from './session-manage-refusal'
import {
  assertUnattendedPolicy,
  registerUnattendedPane,
  setUnattendedPaneResolver,
  UNATTENDED_MERGE_REFUSAL,
  unattendedContextFor,
  withUnattendedContext,
  type UnattendedAction
} from './session-manage-unattended'

const CLEANUP_PANE = 'tab-7:leaf-1'
const STEWARD: SessionManageActor = { kind: 'steward', feature: 'rules' }
const cleanupPane: SessionManageActor = {
  kind: 'pane',
  paneKey: CLEANUP_PANE,
  title: 'Session cleanup'
}
const personPane: SessionManageActor = { kind: 'pane', paneKey: 'tab-1:leaf-1', title: 'Manager' }
const idle = { title: 'Parser fix', keepGoing: false }

const cleanups: (() => void)[] = []
function settings(value: Record<string, unknown>, environment: Record<string, string> = {}): void {
  cleanups.push(configureStewardSwitches({ readSettings: () => value, environment }))
}

beforeEach(() => settings({}))
afterEach(() => {
  while (cleanups.length) {
    cleanups.pop()!()
  }
})

function register(paneKey = CLEANUP_PANE): void {
  cleanups.push(registerUnattendedPane(paneKey, { source: 'cleanup-run', runId: 'run-1' }))
}

describe('the steward actor', () => {
  it('reads as the Session steward in markers, ids and titles', () => {
    expect(sessionManageActorTitle(STEWARD)).toBe('Session steward')
    expect(sessionManagePromptMarker(sessionManageActorTitle(STEWARD))).toBe(
      '[from Session steward] '
    )
    expect(sessionManageActorId(STEWARD)).toBe('steward')
    expect(unattendedContextFor(STEWARD)).toEqual({ source: 'rules' })
  })

  it('can never be resolved from a caller, whatever its evidence claims', () => {
    const claim = {
      kind: 'steward',
      feature: 'rules',
      paneKey: 'tab-3:leaf-3',
      terminalHandle: 'term_3',
      launchToken: 'forged'
    } as never
    expect(
      resolveSessionManageActor(
        claim,
        () => null,
        () => null
      )
    ).toEqual({
      kind: 'cli',
      unverifiedPaneKey: 'tab-3:leaf-3'
    })
    expect(
      resolveSessionManageActor(
        claim,
        () => 'tab-3:leaf-3',
        () => 'Ads'
      )
    ).toEqual({
      kind: 'pane',
      paneKey: 'tab-3:leaf-3',
      title: 'Ads'
    })
  })
})

describe('the unattended registry', () => {
  it('stamps a registered automatic run’s pane, proven or merely claimed, and nothing else', () => {
    register()
    const stamped = withUnattendedContext(cleanupPane)
    expect(stamped).toMatchObject({
      kind: 'pane',
      unattended: { source: 'cleanup-run', runId: 'run-1', since: expect.any(Number) }
    })
    expect(sessionManageActorTitle(stamped)).toBe('Session steward')
    expect(
      unattendedContextFor(withUnattendedContext({ kind: 'cli', unverifiedPaneKey: CLEANUP_PANE }))
    ).toMatchObject({ source: 'cleanup-run' })
    expect(withUnattendedContext(personPane)).toEqual(personPane)
    expect(unattendedContextFor(personPane)).toBeNull()
    expect(unattendedContextFor({ kind: 'cli' })).toBeNull()
  })

  it('finds an unstamped actor through the registry, and forgets it once released', () => {
    const release = registerUnattendedPane(CLEANUP_PANE, { source: 'cleanup-run' })
    expect(unattendedContextFor(cleanupPane)).toMatchObject({ source: 'cleanup-run' })
    release()
    expect(unattendedContextFor(cleanupPane)).toBeNull()
  })

  it('asks a durable resolver after the registry, and fails closed when it throws', () => {
    cleanups.push(
      setUnattendedPaneResolver((paneKey) =>
        paneKey === 'tab-8:leaf-1' ? { source: 'cleanup-run', runId: 'run-8' } : null
      )
    )
    expect(unattendedContextFor({ ...cleanupPane, paneKey: 'tab-8:leaf-1' })).toEqual({
      source: 'cleanup-run',
      runId: 'run-8'
    })
    expect(unattendedContextFor(personPane)).toBeNull()
    cleanups.push(
      setUnattendedPaneResolver(() => {
        throw new Error('run store unreadable')
      })
    )
    expect(unattendedContextFor(personPane)).toEqual({ source: 'cleanup-run' })
  })
})

describe('assertUnattendedPolicy', () => {
  const never: UnattendedAction[] = [
    'stop',
    'restart',
    'rename',
    'answer',
    'assign',
    'organize',
    'folder-change',
    'resume',
    'hold'
  ]

  it('is a no-op for anything a person is behind', () => {
    for (const action of [...never, 'handoff', 'yes', 'archive'] as UnattendedAction[]) {
      expect(assertUnattendedPolicy(personPane, action, idle)).toBeNull()
    }
  })

  it('refuses a steward handoff or merge (D5) and every action that needs the person', () => {
    register()
    for (const actor of [STEWARD, cleanupPane]) {
      expect(() => assertUnattendedPolicy(actor, 'handoff')).toThrow(UNATTENDED_MERGE_REFUSAL)
      expect(() => assertUnattendedPolicy(actor, 'consolidate')).toThrow(UNATTENDED_MERGE_REFUSAL)
      for (const action of never) {
        expect(() => assertUnattendedPolicy(actor, action)).toThrow(/that needs the person/)
      }
    }
  })

  it('allows Yes, nudges, questions and archive with every switch on, never beside Keep going', () => {
    for (const action of ['yes', 'prompt', 'ask', 'archive'] as const) {
      expect(assertUnattendedPolicy(STEWARD, action, idle)).toEqual({ source: 'rules' })
    }
    expect(() =>
      assertUnattendedPolicy(STEWARD, 'prompt', { title: 'Parser fix', keepGoing: true })
    ).toThrow('“Parser fix” is driven by Keep going')
  })

  it('honours each switch: off and shadow both act on nothing', () => {
    settings({ safeYes: 'off', nudges: false, tier2Archive: 'shadow', emptySessionArchive: false })
    expect(() => assertUnattendedPolicy(STEWARD, 'yes', idle)).toThrow(
      'The steward’s “Say yes to safe next steps” switch is off in Settings'
    )
    expect(() => assertUnattendedPolicy(STEWARD, 'prompt', idle)).toThrow(/Nudge sessions/)
    expect(() => assertUnattendedPolicy(STEWARD, 'ask', idle)).toThrow(/Nudge sessions/)
    expect(() => assertUnattendedPolicy(STEWARD, 'archive', idle)).toThrow(/shadow mode/)
    // Either archive rule's switch lets an archive through to the steward's check.
    settings({ tier2Archive: 'off' })
    expect(assertUnattendedPolicy(STEWARD, 'archive', idle)).toEqual({ source: 'rules' })
    expect(stewardFeatureOn('automaticCleanup')).toBe(true)
    settings({ automaticCleanup: false, sessionWaits: false, tier1WaiterCheck: false })
    expect(stewardFeatureOn('automaticCleanup')).toBe(false)
    expect(stewardFeatureOn('sessionWaits')).toBe(false)
    expect(stewardFeatureOn('tier1WaiterCheck')).toBe(false)
  })

  it('stops every steward path with OMNI_STEWARD_DISABLED=1 or `enabled` off', () => {
    settings({}, { OMNI_STEWARD_DISABLED: '1' })
    for (const feature of SESSION_STEWARD_SWITCHES) {
      expect(stewardFeatureOn(feature)).toBe(false)
    }
    for (const action of ['yes', 'prompt', 'ask', 'archive'] as const) {
      expect(() => assertUnattendedPolicy(STEWARD, action, idle)).toThrow(
        'The session steward is stopped on this computer (OMNI_STEWARD_DISABLED)'
      )
    }
    settings({ enabled: false })
    expect(() => assertUnattendedPolicy(STEWARD, 'yes', idle)).toThrow(
      'The session steward is switched off in Settings'
    )
    expect(() => assertUnattendedPolicy(personPane, 'yes', idle)).not.toThrow()
  })

  it('lets only the rules loop close a blank session, and only while its rule closes', () => {
    expect(assertUnattendedPolicy(STEWARD, 'close', idle)).toEqual({ source: 'rules' })
    register()
    expect(() => assertUnattendedPolicy(cleanupPane, 'close')).toThrow(/that needs the person/)
    settings({ emptySessionAction: 'archive' })
    expect(() => assertUnattendedPolicy(STEWARD, 'close', idle)).toThrow(/set to archive/)
    settings({ emptySessionArchive: false })
    expect(() => assertUnattendedPolicy(STEWARD, 'close', idle)).toThrow(
      /Clean up sessions nobody prompted/
    )
  })

  it('throws a plain refusal, so the RPC answers with nothing changed', () => {
    expect(() => assertUnattendedPolicy(STEWARD, 'stop')).toThrow(SessionManageRefusal)
  })
})
