import { blockTitle } from '../up-next-labels'
import { translate as t } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { UpNextPromptBlock, UpNextView } from '../../../../../shared/up-next-types'
import type { UpNextController } from '../use-up-next'

export function PromptBlock({
  block,
  view,
  controller
}: {
  block: UpNextPromptBlock
  view: UpNextView
  controller: UpNextController
}) {
  if (block.locked) {
    return <p className="min-w-0 whitespace-pre-wrap break-words">{block.text}</p>
  }
  const busy = view.header.state === 'running'
  const head =
    block.target.kind === 'current' &&
    view.blocks
      .slice(0, view.blocks.indexOf(block))
      .every((item) => item.kind === 'prompt' && item.target.kind === 'current')
  const target = block.target
  // The host names the agent only while it is the current work; idle or a running stage
  // leaves it unknown, and a guess is not allowed (amendment 2 names it when it can).
  const agent = view.now.kind === 'current-work' ? view.now.agent : ''
  const parent =
    target.kind === 'current' ? undefined : view.blocks.find((item) => item.id === target.blockId)
  return (
    <fieldset disabled={controller.disabled} className="min-w-0 space-y-2">
      <Textarea
        key={block.text}
        defaultValue={block.text}
        aria-label={t('upNext.promptText', 'Prompt text')}
        onBlur={(event) => {
          if (event.target.value.trim() && event.target.value !== block.text) {
            void controller.update(block.id, { kind: 'prompt', text: event.target.value })
          }
        }}
      />
      <div className="flex flex-wrap gap-2">
        {[
          t('upNext.bestJob', 'Have you done your best job?'),
          t('upNext.continue', 'Continue')
        ].map((text) => (
          <Button
            key={text}
            size="xs"
            variant="outline"
            onClick={() => void controller.update(block.id, { kind: 'prompt', text })}
          >
            {text}
          </Button>
        ))}
      </div>
      {!head && parent && (
        <p className="text-xs text-muted-foreground">
          {target.kind === 'stage'
            ? t(
                'upNext.runsWhenStage',
                'Runs when {{number}} · {{title}} runs. Nothing to schedule.',
                { number: parent.number, title: blockTitle(parent) }
              )
            : target.kind === 'resume-after-review' && parent.kind === 'person'
              ? agent
                ? t(
                    'upNext.deliveredAfterReviewNamed',
                    'Delivered to {{agent}} when it resumes after {{names}} reply. Nothing to schedule.',
                    { agent, names: parent.people.map((person) => person.name).join(', ') }
                  )
                : t(
                    'upNext.deliveredAfterReview',
                    'Delivered to the current agent when it resumes after {{names}} reply. Nothing to schedule.',
                    { names: parent.people.map((person) => person.name).join(', ') }
                  )
              : null}
        </p>
      )}
      {head && (
        <div
          className="flex flex-wrap items-center gap-2"
          role="group"
          aria-label={t('upNext.when', 'When')}
        >
          <span className="min-w-16 text-muted-foreground">{t('upNext.when', 'When')}</span>
          {(busy ? (['after', 'now'] as const) : (['now', 'after'] as const)).map((when) => (
            <Button
              key={when}
              size="xs"
              variant={block.when === when ? 'secondary' : 'ghost'}
              aria-pressed={block.when === when}
              onClick={() => void controller.update(block.id, { kind: 'prompt', when })}
            >
              {when === 'now'
                ? busy
                  ? t('upNext.whenNowBusy', 'Now — interrupts the running agent')
                  : t('upNext.whenNowIdle', 'Now (default)')
                : busy
                  ? t('upNext.whenAfterBusy', 'After current work (default)')
                  : t('upNext.whenAfterIdle', 'After current work')}
            </Button>
          ))}
        </div>
      )}
    </fieldset>
  )
}
