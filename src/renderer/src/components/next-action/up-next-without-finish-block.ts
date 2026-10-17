import { upNextCanAdd, upNextNumber } from '../../../../shared/up-next-order'
import { upNextNotation, upNextSummary } from '../../../../shared/up-next-summary'
import type { UpNextView } from '../../../../shared/up-next-types'

/** Old hosts/records may project a Done block; the session preference is outside the track. */
export function upNextWithoutFinishBlock(view: UpNextView): UpNextView {
  if (!view.blocks.some((block) => block.kind === 'done')) {
    return view
  }
  const work = view.blocks.filter((block) => block.kind !== 'done')
  const numbering = upNextNumber(work)
  const blocks = work.map((block, index) => ({
    ...block,
    number: numbering.numbers[index] ?? ''
  }))
  const facts = { blocks, header: view.header, now: view.now }
  return {
    ...view,
    blocks,
    notation: upNextNotation(facts),
    summary: upNextSummary(facts),
    canAdd: upNextCanAdd(blocks, view.header.state),
    draftCount: blocks.filter((block) => block.state === 'draft').length,
    queuedCount: blocks.filter((block) => block.state === 'queued').length
  }
}
