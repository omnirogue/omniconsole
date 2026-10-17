import { describe, expect, it } from 'vitest'
import { revokeWriteFencesWhere } from '../runtime/conversation-write-fence'
import type { SessionLatestTurn } from './session-manage-freeform'
import { transferCheckpoints } from './session-transfer-checkpoints'
import { transferSession } from './session-manage-transfer-fixtures'

function fixture() {
  const source = transferSession('source')
  const turn = {
    conversation: source.source!,
    turnKey: 'brief',
    replyComplete: true as const,
    lastAssistantMessage: 'The whole brief'
  }
  let latest: SessionLatestTurn = {
    known: true,
    complete: true,
    turnKey: turn.turnKey,
    text: turn.lastAssistantMessage,
    proposal: null,
    empty: false
  }
  const proof = transferCheckpoints(
    () => latest,
    () => () => true
  )
  proof.capture(source, turn)
  return {
    source,
    proof,
    replace: (value: SessionLatestTurn) => {
      latest = value
    },
    latest
  }
}

describe('source and acknowledgement checkpoints', () => {
  it('retains the complete producing turn until archive', () => {
    const { source, proof } = fixture()
    try {
      expect(() => proof.assert([source])).not.toThrow()
    } finally {
      proof.close()
    }
  })

  it('refuses a source that finishes new work and becomes idle again', () => {
    const { source, proof, replace, latest } = fixture()
    try {
      replace({ ...latest, turnKey: 'new-work', text: 'Later result' })
      expect(() => proof.assert([source])).toThrow('changed after its transfer reply')
    } finally {
      proof.close()
    }
  })

  it('human input permanently revokes even if the old reply still reads identically', () => {
    const { source, proof } = fixture()
    try {
      revokeWriteFencesWhere((candidate) => candidate.paneKey === source.source!.paneKey, 'input')
      expect(() => proof.assert([source])).toThrow('changed after its transfer reply')
    } finally {
      proof.close()
    }
  })

  it('missing checkpoint or a changed full reply never authorizes archive', () => {
    const { source, proof, replace, latest } = fixture()
    try {
      expect(() => proof.assert([transferSession('other')])).toThrow()
      replace({ ...latest, text: 'Same turn, different final text' })
      expect(() => proof.assert([source])).toThrow()
    } finally {
      proof.close()
    }
  })
})
