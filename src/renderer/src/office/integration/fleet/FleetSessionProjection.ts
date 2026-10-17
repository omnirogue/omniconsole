import type { Task, TaskStatus, ActionLogEntry } from '../store/coreStore'
import { useCoreStore } from '../store/coreStore'
import { useUiStore } from '../store/uiStore'
import { getActiveAgentSet } from '../store/teamStore'
import { getAllAgents, fleetAgentIndex } from '../../data/agents'
import type { AgentState } from '../../types'
import type { FleetSession } from './fleetTypes'
import {
  composeDescription,
  composeTitle,
  labelFor,
  mapStatus,
  norm
} from './fleetSessionPresentation'

export class FleetSessionProjection {
  private prevSessions = new Map<string, { status: TaskStatus; idx: number; title: string }>()

  public reconcile(
    sessions: FleetSession[],
    logs: Omit<ActionLogEntry, 'id' | 'timestamp'>[]
  ): void {
    const now = Date.now()
    const prevTasks = useCoreStore.getState().tasks
    const byId = new Map(prevTasks.map((t) => [t.id, t]))

    const nextTasks: Task[] = []
    const liveIds = new Set<string>()
    // Aggregate work-state per character index for uiStore.agentStatuses.
    const agentState = new Map<number, AgentState>()

    for (const s of sessions) {
      if (!s || !s.id) {
        continue
      }
      if (s.personal) {
        continue
      } // never surface personal sessions
      const idx = fleetAgentIndex(s.agent_name, s.kind || s.source || s.agent_profile)
      const status = mapStatus(s)
      const title = composeTitle(s)
      const taskId = `sess:${s.id}`
      liveIds.add(taskId)

      const prev = byId.get(taskId)
      const task: Task = {
        id: taskId,
        title,
        description: composeDescription(s),
        assignedAgentId: idx,
        status,
        // True only when the hub itself says a human is being asked (attention_state).
        requiresUserApproval:
          status === 'on_hold' && !!s.attention_state && norm(s.attention_state) !== 'none',
        // The session's recorded failure, so the reviewer sees the reason, not 'No content produced.'
        draftOutput: s.error ? `Session failed: ${String(s.error)}` : prev?.draftOutput,
        revisions: prev?.revisions ?? [],
        output: prev?.output,
        createdAt: prev?.createdAt ?? now,
        updatedAt: prev && prev.status === status ? prev.updatedAt : now
      }
      nextTasks.push(task)

      // aggregate character state: working > on_hold > idle
      const cur = agentState.get(idx)
      const rank = (st: AgentState) => (st === 'working' ? 3 : st === 'on_hold' ? 2 : 1)
      const mine: AgentState =
        status === 'in_progress' ? 'working' : status === 'on_hold' ? 'on_hold' : 'idle'
      if (!cur || rank(mine) > rank(cur)) {
        agentState.set(idx, mine)
      }

      // transition / new-session log rows
      const before = this.prevSessions.get(s.id)
      if (!before) {
        logs.push({
          agentIndex: idx,
          action: `New session — ${title} [${labelFor(status)}]`,
          taskId
        })
      } else if (before.status !== status) {
        logs.push({
          agentIndex: idx,
          action: `${labelFor(before.status)} → ${labelFor(status)} — ${title}`,
          taskId
        })
      }
      this.prevSessions.set(s.id, { status, idx, title })
    }

    // Absence from a poll cannot establish that a session exited or its work completed.
    for (const [sid, info] of this.prevSessions) {
      const taskId = `sess:${sid}`
      if (liveIds.has(taskId)) {
        continue
      }
      logs.push({
        agentIndex: info.idx,
        action: `Session unavailable in latest poll — ${info.title}`,
        taskId
      })
      this.prevSessions.delete(sid)
    }

    // Limit terminal sessions explicitly reported by the hub.
    const active = nextTasks.filter((t) => t.status !== 'done')
    const done = nextTasks
      .filter((t) => t.status === 'done')
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 12)
    useCoreStore.setState({ tasks: [...active, ...done] })

    // push aggregated character states into the sim store
    const ui = useUiStore.getState()
    for (const a of getAllAgents(getActiveAgentSet())) {
      const st = agentState.get(a.index) ?? 'idle'
      if (ui.agentStatuses[a.index] !== st) {
        ui.setAgentStatus(a.index, st)
      }
    }
  }
}
