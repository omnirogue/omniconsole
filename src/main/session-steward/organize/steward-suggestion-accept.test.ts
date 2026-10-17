import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionManageActor } from '../../../shared/session-manage-types'
import { auditActor } from '../../session-manage/session-actions-log'
import {
  actorOfExecutor,
  admitUnattendedOrganization
} from '../../session-manage/session-manage-unattended-admission'
import {
  assertUnattendedPolicy,
  UNATTENDED_MERGE_REFUSAL,
  unattendedContextFor
} from '../../session-manage/session-manage-unattended'
import { configureStewardSwitches } from '../steward-switches'
import {
  acceptStewardSuggestion,
  registerStewardSuggestionAcceptor,
  stewardSuggestionActor,
  type StewardSuggestionAcceptContext
} from './steward-suggestion-accept'
import { StewardSuggestionsStore } from './steward-suggestions-store'

let directory: string
let suggestions: StewardSuggestionsStore
const cleanups: (() => void)[] = []

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'steward-accept-'))
  suggestions = new StewardSuggestionsStore({ directory })
  cleanups.push(configureStewardSwitches({ readSettings: () => ({}), environment: {} }))
})
afterEach(async () => {
  while (cleanups.length) {
    cleanups.pop()!()
  }
  await suggestions.flush()
  await rm(directory, { recursive: true, force: true })
})

async function mergeSuggestion() {
  const suggestion = await suggestions.propose({
    kind: 'merge',
    targets: [{ sessionKey: 'a' }, { sessionKey: 'b' }],
    proposal: { into: { sessionKey: 'b' } },
    title: 'Merge “a” into “b”?',
    evidence: 'Same deliverable'
  })
  return suggestion!
}

describe('accepting a steward suggestion in Work', () => {
  it('runs with feature `suggestion` and the recorded request, as a person-approved action', async () => {
    const suggestion = await mergeSuggestion()
    const seen: {
      context: StewardSuggestionAcceptContext
      unattended: unknown
      consolidate: unknown
      organize: unknown
      relayed: unknown
    }[] = []
    cleanups.push(
      registerStewardSuggestionAcceptor('merge', async (accepted, context) => {
        expect(accepted.id).toBe(suggestion.id)
        // The change path rebuilds the actor from the executor and audit line it records.
        const relayedActor = actorOfExecutor(
          { kind: 'app', feature: 'steward' },
          auditActor(context.actor)
        )!
        seen.push({
          context,
          unattended: unattendedContextFor(context.actor),
          consolidate: assertUnattendedPolicy(context.actor, 'consolidate'),
          organize: assertUnattendedPolicy(context.actor, 'organize'),
          relayed: await admitUnattendedOrganization(relayedActor, {
            kind: 'move',
            value: 'folder-1',
            targets: [{ sessionKey: 'a' }]
          })
        })
        return { summary: 'Merged “a” into “b”.' }
      })
    )

    const result = await acceptStewardSuggestion(suggestions, suggestion.id)

    expect(seen).toEqual([
      {
        context: {
          actor: { kind: 'steward', feature: 'suggestion', suggestionId: suggestion.id },
          request: 'accepted in Work'
        },
        unattended: null,
        consolidate: null,
        organize: null,
        relayed: null
      }
    ])
    expect(auditActor(seen[0]!.context.actor)).toEqual({
      actor: 'steward',
      steward: { feature: 'suggestion', suggestionId: suggestion.id }
    })
    expect(result.summary).toBe('Merged “a” into “b”.')
    expect(result.suggestion).toMatchObject({ state: 'accepted', outcome: 'Merged “a” into “b”.' })
    await expect(acceptStewardSuggestion(suggestions, suggestion.id)).rejects.toThrow(
      'already accepted'
    )
  })

  it('reads the same actor as unattended outside the acceptance (fails closed)', async () => {
    const suggestion = await mergeSuggestion()
    const actor: SessionManageActor = stewardSuggestionActor(suggestion.id)
    expect(unattendedContextFor(actor)).toEqual({ source: 'rules' })
    expect(() => assertUnattendedPolicy(actor, 'consolidate')).toThrow(UNATTENDED_MERGE_REFUSAL)
    const forged = actorOfExecutor(
      { kind: 'app', feature: 'steward' },
      { steward: { feature: 'suggestion' } }
    )!
    await expect(
      admitUnattendedOrganization(forged, {
        kind: 'move',
        value: 'folder-1',
        targets: [{ sessionKey: 'a' }]
      })
    ).rejects.toThrow('A steward run cannot')
  })

  it('leaves the suggestion open when the action fails, and releases the approval', async () => {
    const suggestion = await mergeSuggestion()
    let actor: SessionManageActor | null = null
    cleanups.push(
      registerStewardSuggestionAcceptor('merge', async (_accepted, context) => {
        actor = context.actor
        throw new Error('“a” is working; finish or stop its attempt first.')
      })
    )
    await expect(acceptStewardSuggestion(suggestions, suggestion.id)).rejects.toThrow(
      'finish or stop its attempt first'
    )
    expect((await suggestions.get(suggestion.id))?.state).toBe('open')
    expect(unattendedContextFor(actor!)).toEqual({ source: 'rules' })
  })

  it('refuses while the steward is stopped, and for kinds with no action', async () => {
    const suggestion = await mergeSuggestion()
    cleanups.push(registerStewardSuggestionAcceptor('merge', async () => ({ summary: 'done' })))
    cleanups.push(
      configureStewardSwitches({
        readSettings: () => ({}),
        environment: { OMNI_STEWARD_DISABLED: '1' }
      })
    )
    await expect(acceptStewardSuggestion(suggestions, suggestion.id)).rejects.toThrow(
      'stopped on this computer'
    )
    cleanups.pop()!()
    const unplaced = await suggestions.propose({
      kind: 'unplaced',
      targets: [{ sessionKey: 'c' }],
      proposal: { keys: ['c'] },
      title: '1 session could not be placed',
      evidence: ''
    })
    await expect(acceptStewardSuggestion(suggestions, unplaced!.id)).rejects.toThrow(
      'filed from the sidebar'
    )
  })
})
