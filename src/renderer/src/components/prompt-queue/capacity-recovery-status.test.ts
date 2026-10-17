import { describe, expect, it } from 'vitest'
import { classifyConversation } from '@/lib/conversation-retention'
import { dotStateForCard } from '@/lib/session-pane-cards'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { buildAgentPaneSnapshot } from '../attention/agent-pane-snapshot'
import {
  ATTENTION_FIXTURE_NOW,
  ATTENTION_FIXTURE_PANE_A,
  ATTENTION_FIXTURE_PANE_B,
  attentionFixtureEntry,
  attentionFixtureInputs
} from '../attention/attention-test-fixtures'

describe('interrupted source visibility during account recovery', () => {
  it.each([
    { failed: true, failureReason: 'usage_limit_reached' },
    { interrupted: true }
  ] satisfies Partial<AgentStatusEntry>[])(
    'keeps a failed or interrupted source outside Done and Needs You while its replacement works: %o',
    (flags) => {
      const snapshot = buildAgentPaneSnapshot(
        attentionFixtureInputs({
          agentStatusByPaneKey: {
            [ATTENTION_FIXTURE_PANE_A]: attentionFixtureEntry(
              ATTENTION_FIXTURE_PANE_A,
              'tab-a',
              'w1',
              { state: 'done', ...flags }
            ),
            [ATTENTION_FIXTURE_PANE_B]: attentionFixtureEntry(
              ATTENTION_FIXTURE_PANE_B,
              'tab-b',
              'w2',
              { state: 'working' }
            )
          }
        }),
        ATTENTION_FIXTURE_NOW
      )
      const source = snapshot.cardsByPaneKey.get(ATTENTION_FIXTURE_PANE_A)!
      expect(source).toMatchObject({ dotState: 'idle', bucket: 'idle' })
      expect(snapshot.cardsByPaneKey.get(ATTENTION_FIXTURE_PANE_B)).toMatchObject({
        dotState: 'working',
        bucket: 'working'
      })
      expect(snapshot.attention).toEqual([])
      expect(
        classifyConversation({
          now: ATTENTION_FIXTURE_NOW + 86_400_000,
          state: dotStateForCard(source),
          canonicalBucket: source.bucket,
          stateChangedAt: source.stateChangedAt,
          waitingUntil: null,
          attention: false,
          unavailable: false
        })
      ).toEqual({ group: 'stopped', completed: null })
    }
  )

  it('preserves genuine questions and normal successful provider completion', () => {
    const snapshot = buildAgentPaneSnapshot(
      attentionFixtureInputs({
        agentStatusByPaneKey: {
          [ATTENTION_FIXTURE_PANE_A]: attentionFixtureEntry(
            ATTENTION_FIXTURE_PANE_A,
            'tab-a',
            'w1',
            { state: 'waiting', interactivePrompt: 'Which account should receive access?' }
          ),
          [ATTENTION_FIXTURE_PANE_B]: attentionFixtureEntry(
            ATTENTION_FIXTURE_PANE_B,
            'tab-b',
            'w2',
            { state: 'done' }
          )
        }
      }),
      ATTENTION_FIXTURE_NOW
    )
    expect(snapshot.attention.map((entry) => entry.paneKey)).toEqual([ATTENTION_FIXTURE_PANE_A])
    expect(snapshot.cardsByPaneKey.get(ATTENTION_FIXTURE_PANE_B)).toMatchObject({
      dotState: 'done',
      bucket: 'done'
    })
  })
})
