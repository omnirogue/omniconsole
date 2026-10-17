import { useEffect, useRef, type ReactNode } from 'react'
import { TreePalm } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useQuietWorkspace } from '@/store/quiet-workspace'
import { useAgentPaneSnapshot } from '@/components/attention/use-agent-pane-snapshot'
import { QuietBeach } from './QuietBeach'

export function QuietWorkspaceToggle() {
  const enabled = useQuietWorkspace((s) => s.enabled)
  const toggle = useQuietWorkspace((s) => s.toggle)
  const label = enabled
    ? translate('quietWorkspace.show', 'Show conversation')
    : translate('quietWorkspace.hide', 'Take a break from the output')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="mr-1"
          aria-label={label}
          aria-pressed={enabled}
          onClick={toggle}
        >
          <TreePalm className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}

function QuietStatus() {
  const snapshot = useAgentPaneSnapshot()
  // Why: the list already holds only what asks a person: an ordinary pane's own prompt, and each
  // pursued run's open request, once. A run that stopped, failed or finished is not in it.
  const needsYou = snapshot.attention.length
  const ready = snapshot.cards.filter((card) => card.dotState === 'done' && card.unseen).length
  return (
    <p className="text-sm text-muted-foreground" role="status">
      {needsYou > 0
        ? translate(
            needsYou === 1 ? 'quietWorkspace.needsYouOne' : 'quietWorkspace.needsYou',
            needsYou === 1
              ? 'One session needs your attention.'
              : '{{count}} sessions need your attention.',
            {
              count: needsYou
            }
          )
        : ready > 0
          ? translate(
              ready === 1 ? 'quietWorkspace.readyOne' : 'quietWorkspace.ready',
              ready === 1
                ? 'One session has a result to review.'
                : '{{count}} sessions have a result to review.',
              {
                count: ready
              }
            )
          : translate(
              'quietWorkspace.pause',
              'Let the agents work. Return when a result or decision is ready.'
            )}
    </p>
  )
}

/** Keep the workbench mounted and sized: covering the output never pauses or restarts work. */
export function QuietWorkspace({
  children,
  available
}: {
  children: ReactNode
  available: boolean
}) {
  const enabled = useQuietWorkspace((s) => s.enabled)
  const background = useQuietWorkspace((s) => s.background)
  const toggle = useQuietWorkspace((s) => s.toggle)
  const setBackground = useQuietWorkspace((s) => s.setBackground)
  const covered = available && enabled
  const cover = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (covered) {
      cover.current?.focus()
    }
  }, [covered])
  return (
    <>
      <div
        className="flex flex-1 min-w-0 min-h-0 flex-col"
        inert={covered}
        aria-hidden={covered || undefined}
        style={{ visibility: covered ? 'hidden' : undefined }}
      >
        {children}
      </div>
      {covered ? (
        <div
          ref={cover}
          tabIndex={-1}
          className="absolute inset-0 z-20 flex items-center justify-center overflow-hidden bg-background text-foreground outline-none"
          data-quiet-workspace={background}
        >
          {background === 'beach' ? <QuietBeach /> : null}
          <div className="relative mx-6 max-w-md space-y-4 rounded-xl border bg-background/95 p-6 text-center">
            <TreePalm className="mx-auto size-7 text-muted-foreground" aria-hidden />
            <p className="text-lg font-medium">
              {translate('quietWorkspace.title', 'A little breathing room')}
            </p>
            <QuietStatus />
            <Button variant="outline" onClick={toggle}>
              {translate('quietWorkspace.show', 'Show conversation')}
            </Button>
            <div
              className="flex justify-center gap-1"
              role="group"
              aria-label={translate('quietWorkspace.background', 'Your background')}
            >
              <Button
                variant="ghost"
                size="xs"
                aria-pressed={background === 'beach'}
                onClick={() => setBackground('beach')}
              >
                {translate('quietWorkspace.beach', 'Beach')}
              </Button>
              <Button
                variant="ghost"
                size="xs"
                aria-pressed={background === 'plain'}
                onClick={() => setBackground('plain')}
              >
                {translate('quietWorkspace.plain', 'Plain')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
