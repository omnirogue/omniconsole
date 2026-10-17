import { askIndexForMessage, type SessionAsk } from '../../../shared/session-asks'
import type { FilesAndLinksCard } from './session-files-and-links'

/** What one ask produced, counted by the kind a person recognises. */
export type SessionAskOutputs = {
  pullRequests: number[]
  images: number
  videos: number
  audio: number
  documents: number
  links: number
}

function emptyOutputs(): SessionAskOutputs {
  return { pullRequests: [], images: 0, videos: 0, audio: 0, documents: 0, links: 0 }
}

function tally(outputs: SessionAskOutputs, card: FilesAndLinksCard): void {
  switch (card.type) {
    case 'pull-request':
      outputs.pullRequests.push(card.number)
      return
    case 'folder':
      outputs.documents += card.count
      return
    case 'link':
      outputs.links += 1
      return
    case 'file':
      if (card.kind === 'image') {
        outputs.images += 1
      } else if (card.kind === 'video') {
        outputs.videos += 1
      } else if (card.kind === 'audio') {
        outputs.audio += 1
      } else {
        outputs.documents += 1
      }
  }
}

/** Each ask's outputs, by the message that produced them; outputs before the first ask are dropped. */
export function sessionAskOutputs(
  asks: readonly SessionAsk[],
  cards: readonly FilesAndLinksCard[]
): SessionAskOutputs[] {
  const byAsk = asks.map(() => emptyOutputs())
  for (const card of cards) {
    const messageIndex = card.type === 'folder' ? undefined : card.messageIndex
    if (messageIndex === undefined) {
      continue
    }
    const position = askIndexForMessage(asks, messageIndex)
    if (position >= 0) {
      tally(byAsk[position]!, card)
    }
  }
  for (const outputs of byAsk) {
    outputs.pullRequests.sort((a, b) => a - b)
  }
  return byAsk
}
