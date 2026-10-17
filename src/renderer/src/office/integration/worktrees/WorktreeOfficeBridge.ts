import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { selectWorktreeAgentActivitySummary } from '@/components/sidebar/worktree-agent-activity-summary'
import type { AppState } from '@/store/types'
import type { Worktree } from '../../../../../shared/worktree/types'

import { MAX_AGENTS, type AgentNode, type AgenticSystem } from '../../data/agents'
import { useCoreStore, type Task, type TaskStatus } from '../store/coreStore'
import { useTeamStore } from '../store/teamStore'
import { useUiStore } from '../store/uiStore'
import type { AgentState } from '../../types'

/** The synthesized team id. Never persisted as a user team — it is rebuilt from
 *  live state on every change, so it must not collide with a real one. */
export const WORKTREE_SET_ID = 'omni-worktrees'

/** Desk seats. Index 0 is the operator and index 1 is the lead, so the office
 *  can seat MAX_AGENTS - 1 workspaces before it starts leaving some out. */
const MAX_WORKSPACE_SEATS = MAX_AGENTS - 1

const LEAD_INDEX = 1
const FIRST_WORKSPACE_INDEX = 2

// A stable colour per seat: the office draws characters by colour, so a
// workspace must keep the same one between refreshes or the room reshuffles.
const SEAT_COLORS = [
  '#D97757',
  '#10A37F',
  '#6366F1',
  '#EAB308',
  '#EC4899',
  '#06B6D4',
  '#84CC16',
  '#F97316',
  '#8B5CF6',
  '#14B8A6',
  '#F43F5E',
  '#A3A3A3'
]

type WorkspaceSeat = {
  worktreeId: string
  index: number
  name: string
  detail: string
  state: AgentState
  status: TaskStatus
}

function seatColor(i: number): string {
  return SEAT_COLORS[i % SEAT_COLORS.length]
}

/**
 * What the office should show for one workspace.
 *
 * The office has three character states, and the sidebar's own summary already
 * decides what a workspace is doing — reusing it means the room and the list can
 * never disagree about who is working.
 */
function seatStateFor(
  state: AppState,
  worktreeId: string
): { state: AgentState; status: TaskStatus } {
  const summary = selectWorktreeAgentActivitySummary(state, worktreeId)
  if (summary.hasPermission) {
    // Waiting on a human is the office's "on hold", not idle: the character
    // stands at its desk rather than wandering.
    return { state: 'on_hold', status: 'on_hold' }
  }
  if (summary.hasLiveWorking || summary.hasLiveMonitoring) {
    return { state: 'working', status: 'in_progress' }
  }
  if (summary.hasLiveDone || summary.hasRetainedDone || summary.hasInterrupted) {
    return { state: 'idle', status: 'done' }
  }
  return { state: 'idle', status: 'scheduled' }
}

/**
 * The workspaces the sidebar shows — and only those.
 *
 * The sidebar renders from the detected list, where each worktree carries a
 * `visible` verdict (ownership rules, "hide discovered worktrees", per-repo
 * choices). Seating from the raw adopted list instead put workspaces in the
 * room the user had deliberately hidden, and missed ones the sidebar showed.
 * A repo without a detected result yet falls back to its adopted worktrees, so
 * the office is never empty just because detection has not run.
 */
function visibleWorktrees(state: AppState): Worktree[] {
  const detected = state.detectedWorktreesByRepo ?? {}
  const adopted = state.worktreesByRepo ?? {}
  const repoIds = new Set([...Object.keys(detected), ...Object.keys(adopted)])
  const out: Worktree[] = []
  for (const repoId of repoIds) {
    const result = detected[repoId]
    if (result) {
      for (const worktree of result.worktrees) {
        if (worktree.visible) {
          out.push(worktree)
        }
      }
    } else {
      out.push(...(adopted[repoId] ?? []))
    }
  }
  return out
}

function readSeats(state: AppState): WorkspaceSeat[] {
  const worktrees = visibleWorktrees(state)
  const seats: WorkspaceSeat[] = []
  for (const worktree of worktrees) {
    if (seats.length >= MAX_WORKSPACE_SEATS) {
      break
    }
    const { state: agentState, status } = seatStateFor(state, worktree.id)
    seats.push({
      worktreeId: worktree.id,
      index: FIRST_WORKSPACE_INDEX + seats.length,
      name: worktree.displayName || worktree.id,
      detail: worktree.comment || '',
      state: agentState,
      status
    })
  }
  return seats
}

function buildSystem(seats: WorkspaceSeat[]): AgenticSystem {
  // Lay the desks out in a shallow arc so a wide team stays readable in the
  // configurator's node view; the 3D scene seats them at real POIs instead.
  const spread = 300
  const subagents: AgentNode[] = seats.map((seat, i) => ({
    id: `worktree:${seat.worktreeId}`,
    index: seat.index,
    name: seat.name,
    description: seat.detail || 'Workspace in this app.',
    color: seatColor(i),
    model: 'Workspace',
    position: { x: (i - (seats.length - 1) / 2) * spread, y: 280 }
  }))

  return {
    id: WORKTREE_SET_ID,
    teamName: 'Workspaces',
    teamType: 'Live',
    teamDescription:
      'Every workspace open in this app, seated at its own desk. A character works while its agent is running and stands by when it needs you.',
    color: '#6366F1',
    outputType: 'text',
    outputModel: 'workspaces',
    outputAutoApprove: true,
    user: { index: 0, model: 'Operator', position: { x: 0, y: 0 } },
    leadAgent: {
      id: 'omni-operator-desk',
      index: LEAD_INDEX,
      name: 'Projects',
      get description() {
        return translate(
          'office.schema.workspaces.projects_description',
          'The projects these workspaces belong to.'
        )
      },
      color: '#6366F1',
      model: 'Projects',
      humanInTheLoop: true,
      position: { x: 0, y: 130 },
      subagents
    }
  }
}

function signatureOf(seats: WorkspaceSeat[]): string {
  return seats.map((s) => `${s.worktreeId}|${s.name}|${s.state}|${s.status}`).join('\n')
}

/**
 * WorktreeOfficeBridge — the office runs on THIS app's workspaces.
 *
 * The office shipped with a bridge that polled the backoffice over HTTP, which
 * is all it could see as a separate web app. Vendored into the IDE it can read
 * the real thing: the workspaces in the sidebar, and the agent activity the
 * sidebar already derives for each one. Same stores, same scene — only the
 * source of truth changed, and nothing here invents a workspace that is not
 * open.
 */
export class WorktreeOfficeBridge {
  private unsubscribe: (() => void) | null = null
  private lastSignature = ''

  public start(): void {
    if (this.unsubscribe) {
      return
    }
    this.apply(useAppStore.getState())
    // Zustand fires on every store write; the signature check keeps the office
    // from rebuilding its team on writes that changed nothing it renders.
    this.unsubscribe = useAppStore.subscribe((state) => this.apply(state))
  }

  public dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  private apply(state: AppState): void {
    const seats = readSeats(state)
    const signature = signatureOf(seats)
    if (signature === this.lastSignature) {
      return
    }
    this.lastSignature = signature

    const system = buildSystem(seats)
    useTeamStore.setState((s) => ({
      selectedAgentSetId: WORKTREE_SET_ID,
      customSystems: s.customSystems.some((cs) => cs.id === WORKTREE_SET_ID)
        ? s.customSystems.map((cs) => (cs.id === WORKTREE_SET_ID ? system : cs))
        : [...s.customSystems, system]
    }))
    useUiStore.getState().setInstanceCount(seats.length + 2) // + operator + lead

    const ui = useUiStore.getState()
    for (const seat of seats) {
      ui.setAgentStatus(seat.index, seat.state)
    }

    const now = Date.now()
    const previous = new Map(useCoreStore.getState().tasks.map((t) => [t.id, t]))
    const tasks: Task[] = seats.map((seat) => {
      const id = `worktree:${seat.worktreeId}`
      const prior = previous.get(id)
      return {
        id,
        title: seat.name,
        description: seat.detail,
        assignedAgentId: seat.index,
        status: seat.status,
        requiresUserApproval: seat.status === 'on_hold',
        revisions: prior?.revisions ?? [],
        output: prior?.output,
        createdAt: prior?.createdAt ?? now,
        updatedAt: prior && prior.status === seat.status ? prior.updatedAt : now
      }
    })
    useCoreStore.setState({ tasks, phase: seats.length > 0 ? 'working' : 'idle' })
  }
}
