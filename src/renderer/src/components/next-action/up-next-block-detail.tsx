import type { UpNextBlock, UpNextView } from '../../../../shared/up-next-types'
import type { UpNextController } from './use-up-next'
import { StageFacts } from './NowRow'
import { PromptBlock } from './blocks/PromptBlock'
import { AgentBlock } from './blocks/AgentBlock'
import { PersonBlock } from './blocks/PersonBlock'
import { DoneBlock } from './blocks/DoneBlock'

/** The open row's detail form, by kind; a launched or finished stage shows its facts instead. */
export function BlockDetail({
  block,
  view,
  controller
}: {
  block: UpNextBlock
  view: UpNextView
  controller: UpNextController
}): React.JSX.Element {
  switch (block.kind) {
    case 'prompt':
      return <PromptBlock block={block} view={view} controller={controller} />
    case 'agent':
      return block.locked || block.state === 'running' || block.state === 'done' ? (
        <StageFacts block={block} controller={controller} />
      ) : (
        <AgentBlock block={block} view={view} controller={controller} />
      )
    case 'person':
      return <PersonBlock block={block} view={view} controller={controller} />
    case 'done':
      return <DoneBlock block={block} controller={controller} />
  }
}
