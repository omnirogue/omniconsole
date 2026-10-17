import { captureConsoleWorkflowPerson } from '../backoffice/console-workflow-person'
import { withinRoutineSlackDeadline } from './routine-slack-deadline'
import { hubSlackClient } from './hub-slack-client'
import type { RoutineSlackResult } from '../../shared/routine-alert-contract'
import type { RoutineDeliveryAdapters } from '../automations/routine-run-delivery'

function confirmed(result: RoutineSlackResult) {
  if (!result.ok) {
    throw new Error(result.error ?? 'Slack delivery was refused.')
  }
  return result.permalink ? { permalink: result.permalink } : undefined
}
function createDesktopAdapters(send: typeof hubSlackClient.send): RoutineDeliveryAdapters {
  return {
    desktop: async (summary, link, automation, run) => {
      const { dispatchAppNotification } = await import('../ipc/notifications')
      const result = await dispatchAppNotification({
        source: 'agent-task-complete',
        routineRunLink: link,
        notificationId: `routine:${run.id}`,
        worktreeId: run.workspaceId ?? undefined,
        paneKey: run.terminalPaneKey ?? undefined,
        worktreeLabel: automation.name,
        agentLastAssistantMessage: `${summary}\n${link}`,
        requireDisplayConfirmation: true
      })
      if (!result.delivered) {
        throw new Error(result.reason ?? 'Desktop notification was not delivered.')
      }
    },
    alert: async (channel, text, runLink, automation, run) => {
      if (channel.kind === 'email') {
        throw new Error('No email sender is configured in this app.')
      }
      return confirmed(
        await send({
          ...(channel.kind === 'slack-channel'
            ? ({ kind: 'channel', channel: channel.channelId || channel.channelName } as const)
            : ({ kind: 'dm', email: channel.email } as const)),
          text,
          runLink,
          automationId: automation.id,
          runId: run.id,
          purpose: 'alert'
        })
      )
    },
    deliver: async (target, text, runLink, automation, run) => {
      if (target.kind === 'slack') {
        return confirmed(
          await send({
            kind: 'channel',
            channel: target.channel,
            text,
            runLink,
            automationId: automation.id,
            runId: run.id,
            purpose: 'output'
          })
        )
      }
      throw new Error(
        `${target.kind === 'google-drive' ? 'Google Drive' : 'Hub card'} output delivery is unavailable from this app. The run output remains in its conversation.`
      )
    }
  }
}
export const desktopRoutineDeliveryAdapters = createDesktopAdapters(
  hubSlackClient.send.bind(hubSlackClient)
)
desktopRoutineDeliveryAdapters.prepare = async () => {
  const captured = await withinRoutineSlackDeadline(captureConsoleWorkflowPerson).catch(() => ({
    ok: false as const,
    error: { message: 'Slack sign-in could not be verified within 10 seconds.' }
  }))
  return createDesktopAdapters((payload) =>
    captured.ok
      ? hubSlackClient.send(payload, captured.data)
      : Promise.resolve({ ok: false, error: captured.error.message })
  )
}
