import type { ComponentProps } from 'react'
import { NextStepsStartTray } from './NextStepsStartTray'
import { NextStepsTray } from './NextStepsTray'

type StartProps = ComponentProps<typeof NextStepsStartTray>
type TrayProps = ComponentProps<typeof NextStepsTray>

/** The chat view's next-step surfaces: suggested starts on an empty conversation, then the tray. */
export function ResolvedChatNextSteps({
  showStart,
  worktreeId,
  startActive,
  agent,
  sessionId,
  ...tray
}: Omit<TrayProps, 'compact'> & {
  showStart: boolean
  worktreeId: string | null | undefined
  startActive: boolean
  agent: StartProps['agent']
  sessionId: string | null | undefined
}) {
  return (
    <>
      {showStart && worktreeId ? (
        <NextStepsStartTray
          worktreeId={worktreeId}
          paneKey={tray.paneKey}
          tabId={tray.tabId}
          agent={agent}
          active={startActive}
        />
      ) : null}
      <NextStepsTray key={`recommendations:${tray.paneKey}:${sessionId}`} {...tray} />
    </>
  )
}
