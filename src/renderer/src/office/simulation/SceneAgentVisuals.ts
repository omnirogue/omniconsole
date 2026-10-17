import * as THREE from 'three/webgpu'
import { getAllAgents } from '../data/agents'
import { useCoreStore } from '../integration/store/coreStore'
import { getActiveAgentSet } from '../integration/store/teamStore'
import { useUiStore } from '../integration/store/uiStore'
import type { ChatMessage } from '../types'
import type { CharacterController } from './CharacterController'
import type { DriverManager } from './drivers/DriverManager'
import type { PoiManager } from './world/PoiManager'

export class SceneAgentVisuals {
  constructor(
    private readonly getController: () => CharacterController | null,
    private readonly getDriverManager: () => DriverManager | null,
    private readonly poiManager: PoiManager,
    private readonly selectIndex: (index: number) => void
  ) {}

  private get controller() {
    return this.getController()
  }
  private get driverManager() {
    return this.getDriverManager()
  }

  /** Move an agent's character to match its current task set. Idempotent. */
  public applyTaskVisualForAgent(
    id: number,
    myTasks: { status: string }[],
    justDone: boolean
  ): void {
    const onHold = myTasks.find((t) => t.status === 'on_hold')
    const inProgress = myTasks.find((t) => t.status === 'in_progress')
    if (onHold) {
      this.moveNpcToBoardroom(id)
    } else if (inProgress) {
      this.setNpcWorking(id, true)
    } else if (justDone) {
      this.setNpcWorking(id, false)
      this.moveNpcToSpawn(id)
    }
  }

  public startChatVisuals(npcIndex: number): void {
    if (!this.controller) {
      return
    }
    const pos = this.controller.getCPUPositions()
    if (!pos) {
      return
    }
    const set = getActiveAgentSet()
    const npc = new THREE.Vector3(pos[npcIndex * 4], 0, pos[npcIndex * 4 + 2])
    const player = new THREE.Vector3(pos[set.user.index * 4], 0, pos[set.user.index * 4 + 2])
    const dir = new THREE.Vector3().subVectors(player, npc).normalize()
    if (dir.length() < 0.01) {
      dir.set(1, 0, 0)
    }
    const target = npc.clone().addScaledVector(dir, 1.2)

    this.selectIndex(npcIndex)
    this.driverManager?.getNpcDriver(npcIndex)?.setChatting(true)
    this.controller.cancelMovement(npcIndex)
    this.controller.play(npcIndex, 'listen')
    this.controller.getAgentStateBuffer()?.setWaypoint(npcIndex, dir.x, dir.z)
    this.driverManager?.getPlayerDriver()?.walkTo(target, 'listen', () => {
      const p = this.controller!.getCPUPositions()!
      const fx = p[npcIndex * 4] - p[set.user.index * 4],
        fz = p[npcIndex * 4 + 2] - p[set.user.index * 4 + 2]
      this.controller!.getAgentStateBuffer()?.setWaypoint(set.user.index, fx, fz)
      this.controller!.getAgentStateBuffer()?.setWaypoint(npcIndex, -fx, -fz)
      this._triggerNpcGreeting(npcIndex)
    })
  }

  /**
   * SMART DESK ASSIGNMENT
   * Attempts to find a work POI. If work-${index} is missing, it picks
   * a desk from the 'sit_work' group based on the agent's unique index.
   */
  public setNpcWorking(index: number, working: boolean): void {
    if (!this.controller) {
      return
    }
    if (working) {
      // Idempotent: if already walking to the desk or seated & working, leave it.
      const cur = this.controller.getState(index)
      if (cur === 'walk' || cur === 'sit_work') {
        return
      }
      const id = `sit_work-${index}`
      let poi = this.poiManager.getPoi(id)
      if (!poi) {
        // Smart fallback: assign a desk based on order (agent index is 1-based)
        const desks = this.poiManager.getPoisByPrefix('sit_work')
        if (desks.length > 0) {
          poi = desks[(index - 1) % desks.length]
        }
      }
      if (poi) {
        this.controller.walkToPoi(index, poi.id)
      }
    }
  }

  public setNpcTalking(index: number, talking: boolean): void {
    if (!this.controller) {
      return
    }
    if (talking) {
      if (this.controller.getState(index) !== 'walk') {
        this.controller.play(index, 'talk')
      }
      this.controller.setSpeaking(index, true)
    } else {
      this.controller.setSpeaking(index, false)
      const task = useCoreStore
        .getState()
        .tasks.find((t) => t.status === 'on_hold' && t.assignedAgentId === index)
      this.controller.play(index, task ? 'listen' : 'idle')
    }
  }

  public moveNpcToBoardroom(index: number): void {
    if (!this.controller) {
      return
    }
    // Idempotent: don't re-path while already heading there.
    if (this.controller.getState(index) === 'walk') {
      return
    }
    const poi = this.poiManager.getPoi('area-boardroom') || this.poiManager.getPoi('boardroom')
    if (poi) {
      this.controller.walkToPoi(index, poi.id)
    }
  }

  public moveNpcToSpawn(index: number, onArrival?: () => void): void {
    if (!this.controller) {
      return
    }
    const poi = this.poiManager.getPoi(`spawn-${index}`)
    if (poi) {
      this.controller.moveTo(index, poi.position, 'idle', onArrival, undefined, poi.quaternion)
    } else if (onArrival) {
      onArrival()
    }
  }

  private async _triggerNpcGreeting(idx: number): Promise<void> {
    const set = getActiveAgentSet()
    const agent = getAllAgents(set).find((a) => a.index === idx)
    if (!agent) {
      return
    }
    useUiStore.setState({ isThinking: true })
    const msg: ChatMessage = {
      role: 'assistant',
      text: `Hello. I am ${agent.name}. How can I assist you?`,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }
    useUiStore.setState({ chatMessages: [msg], isThinking: false })
  }
}
