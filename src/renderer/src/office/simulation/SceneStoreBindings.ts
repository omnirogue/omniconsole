import type { AgenticSystem } from '../data/agents'
import { getAgentSet } from '../data/agents'
import { useCoreStore } from '../integration/store/coreStore'
import { getActiveAgentSet, useTeamStore } from '../integration/store/teamStore'
import { useUiStore } from '../integration/store/uiStore'
import type { CharacterController } from './CharacterController'
import type { DriverManager } from './drivers/DriverManager'
import type { SceneAgentVisuals } from './SceneAgentVisuals'

export class SceneStoreBindings {
  private lastAgentSetId: string | null = null

  constructor(
    private readonly getController: () => CharacterController | null,
    private readonly getDriverManager: () => DriverManager | null,
    private readonly visuals: SceneAgentVisuals,
    private readonly onAgentSetChanged: (set: AgenticSystem) => void,
    private readonly selectIndex: (index: number | null) => void
  ) {}

  private get controller() {
    return this.getController()
  }
  private get driverManager() {
    return this.getDriverManager()
  }

  public watchCore() {
    return useCoreStore.subscribe((state, prevState) => {
      const agentIndices = Array.from(
        new Set(
          state.tasks.flatMap((t) =>
            [t.assignedAgentId].filter((id) => id !== undefined && id !== 0)
          )
        )
      )

      agentIndices.forEach((id) => {
        const myTasks = state.tasks.filter((t) => t.assignedAgentId === id)
        const hasChange = myTasks.some((t) => {
          const pt = prevState.tasks.find((old) => old.id === t.id)
          return !pt || pt.status !== t.status
        })

        if (!hasChange) {
          return
        }

        const justDone = myTasks.some(
          (t) =>
            t.status === 'done' &&
            !prevState.tasks.find((pt) => pt.id === t.id && pt.status === 'done')
        )
        this.visuals.applyTaskVisualForAgent(id, myTasks, justDone)
      })
    })
  }

  /**
   * Re-apply every agent's visual state from the CURRENT store. Used once the
   * scene finishes loading so tasks the FleetBridge pushed before the controller
   * existed still animate. Safe to call repeatedly — the movement helpers no-op
   * when the character is already walking or seated at its desk.
   */
  public resyncTasks(): void {
    if (!this.controller) {
      return
    }
    const tasks = useCoreStore.getState().tasks
    const ids = Array.from(
      new Set(tasks.map((t) => t.assignedAgentId).filter((id) => id !== undefined && id !== 0))
    )
    ids.forEach((id) => {
      const myTasks = tasks.filter((t) => t.assignedAgentId === id)
      const justDone = myTasks.length > 0 && myTasks.every((t) => t.status === 'done')
      this.visuals.applyTaskVisualForAgent(id, myTasks, justDone)
    })
  }

  public watchUi() {
    return useUiStore.subscribe((s, prev) => {
      if (s.instanceCount !== prev.instanceCount) {
        this.controller?.setInstanceCount(s.instanceCount)
      }
      const team = useTeamStore.getState()
      if (team.selectedAgentSetId !== this.lastAgentSetId) {
        this.lastAgentSetId = team.selectedAgentSetId
        const set = getAgentSet(team.selectedAgentSetId, team.customSystems)
        this.onAgentSetChanged(set)
      }
      if (
        (s.isChatting !== prev.isChatting ||
          s.isThinking !== prev.isThinking ||
          s.isTyping !== prev.isTyping) &&
        this.controller
      ) {
        const set = getActiveAgentSet()
        if (s.isChatting && !prev.isChatting && s.selectedNpcIndex !== null) {
          this.visuals.startChatVisuals(s.selectedNpcIndex)
        }

        if (s.isChatting && s.selectedNpcIndex !== null) {
          const npc = s.selectedNpcIndex,
            user = set.user.index
          if (this.controller.getState(npc) !== 'walk') {
            this.controller.play(npc, s.isThinking ? 'talk' : 'listen')
          }
          this.controller.setSpeaking(npc, s.isThinking)
          if (this.controller.getState(user) !== 'walk') {
            this.controller.play(user, s.isTyping ? 'talk' : 'listen')
          }
          this.controller.setSpeaking(user, s.isTyping)
        } else if (!s.isChatting && prev.isChatting) {
          // Cleanup Chat Visuals
          const npc = prev.selectedNpcIndex
          const user = set.user.index
          if (npc !== null) {
            this.driverManager?.getNpcDriver(npc)?.setChatting(false)
            this.controller.setSpeaking(npc, false)
            this.controller.play(npc, 'idle')
            this.controller.poiManager.releaseAll(npc)
          }
          this.controller.setSpeaking(user, false)
          this.controller.play(user, 'idle')
          this.selectIndex(null)
        }
      }

      // Monitor individual agent status changes for autonomous animations
      if (s.agentStatuses !== prev.agentStatuses && this.controller) {
        Object.keys(s.agentStatuses).forEach((key) => {
          const idx = Number.parseInt(key)
          const status = s.agentStatuses[idx]
          const prevStatus = prev.agentStatuses[idx]
          if (status !== prevStatus) {
            if (status === 'talking') {
              this.visuals.setNpcTalking(idx, true)
            } else if (prevStatus === 'talking') {
              this.visuals.setNpcTalking(idx, false)
            }
          }
        })
      }
    })
  }
}
