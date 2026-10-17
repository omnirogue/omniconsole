import type { TaskStatus } from '../store/coreStore'
import type { FleetSession } from './fleetTypes'

export function norm(v?: string | null): string {
  return (v ?? '').toLowerCase().trim()
}

/** Map a live session to a Kanban column. */
export function mapStatus(s: FleetSession): TaskStatus {
  const st = norm(s.agent_status)
  const att = norm(s.attention_state)
  if (
    ['needs_input', 'waiting_input', 'waiting', 'blocked', 'attention', 'input', 'review'].some(
      (k) => att.includes(k) && att !== 'none'
    )
  ) {
    return 'on_hold'
  }
  // An errored or reaper-killed session is OVER. It used to land in on_hold,
  // which the office renders as "Approval Needed" — a review request for a
  // corpse, with nothing to approve and buttons that reached no hub verb.
  if (s.error) {
    return 'done'
  }
  if (
    ['run', 'active', 'working', 'busy', 'in_progress', 'streaming', 'thinking'].some((k) =>
      st.includes(k)
    )
  ) {
    return 'in_progress'
  }
  if (['fail', 'error'].some((k) => st.includes(k))) {
    return 'done'
  }
  if (['block', 'stuck', 'hold', 'paused'].some((k) => st.includes(k))) {
    return 'on_hold'
  }
  if (
    ['done', 'exit', 'reap', 'complete', 'finish', 'closed', 'stopped', 'ended'].some((k) =>
      st.includes(k)
    )
  ) {
    return 'done'
  }
  if (
    ['queue', 'pending', 'schedule', 'claim', 'start', 'boot', 'new'].some((k) => st.includes(k))
  ) {
    return 'scheduled'
  }
  // idle/unknown live session → scheduled (present, awaiting work; no work anim)
  return 'scheduled'
}

export function labelFor(st: TaskStatus): string {
  return st === 'in_progress' ? 'in progress' : st === 'on_hold' ? 'on hold' : st
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(-6) : id
}

export function composeTitle(s: FleetSession): string {
  const summary = (s.task_summary ?? '').trim()
  if (summary) {
    return summary.length > 80 ? `${summary.slice(0, 77)}…` : summary
  }
  const agent = s.agent_name || 'agent'
  const machine = s.machine_id || 'local'
  return `${agent} · ${machine} · ${shortId(s.id)}`
}

export function composeDescription(s: FleetSession): string {
  const bits: string[] = []
  if (s.agent_name) {
    bits.push(`agent: ${s.agent_name}${s.agent_profile ? ` (${s.agent_profile})` : ''}`)
  }
  if (s.machine_id) {
    bits.push(`machine: ${s.machine_id}`)
  }
  if (s.agent_status) {
    bits.push(`status: ${s.agent_status}`)
  }
  if (s.attention_state && s.attention_state !== 'none') {
    bits.push(`attention: ${s.attention_state}`)
  }
  if (s.source) {
    bits.push(`source: ${s.source}`)
  }
  if (s.kind) {
    bits.push(`kind: ${s.kind}`)
  }
  if (s.cwd) {
    bits.push(`cwd: ${s.cwd}`)
  }
  if (s.error) {
    bits.push(`error: ${s.error}`)
  }
  return bits.join('\n')
}
