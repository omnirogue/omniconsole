// @ts-nocheck
import type { AgenticSystem } from '../data/agents'
import { getAllAgents } from '../data/agents'
import { CharacterController } from './CharacterController'
import { Engine } from './core/Engine'
import { Stage } from './core/Stage'
import { DriverManager } from './drivers/DriverManager'
import { CharacterManager } from './entities/CharacterManager'
import { InputManager } from './input/InputManager'
import { NavMeshManager } from './pathfinding/NavMeshManager'
import { PoiManager } from './world/PoiManager'
import { WorldManager } from './world/WorldManager'

import { AgentSimulation } from './core/AgentSimulation'
import { useCoreStore } from '../integration/store/coreStore'
import { getActiveAgentSet } from '../integration/store/teamStore'
import { useUiStore } from '../integration/store/uiStore'
import { SceneAgentVisuals } from './SceneAgentVisuals'
import { SceneFrame } from './SceneFrame'
import { SceneStoreBindings } from './SceneStoreBindings'

/**
 * SceneManager — Visual Integration Layer.
 *
 * DESIGN PRINCIPLE: Visual Reflex of Logic.
 * 1. Subscribes to the Store to Decouple logic from 3D.
 * 2. Visual actions are fire-and-forget.
 * 3. Smart POI assignment ensures NPCs find desks even with diverse GLB names.
 */
export class SceneManager {
  private engine: Engine
  private stage: Stage
  private characterManager: CharacterManager
  private controller: CharacterController | null = null
  private navMesh: NavMeshManager
  private poiManager: PoiManager
  private worldManager: WorldManager
  private driverManager: DriverManager | null = null
  private simulation: AgentSimulation | null = null

  private visuals: SceneAgentVisuals
  private frame: SceneFrame
  private bindings: SceneStoreBindings
  private selectedIndex: number | null = null
  private coreHandler: ((npcIndex: number, text: string) => Promise<string | null>) | null = null

  private unsubs: (() => void)[] = []
  private isDisposed = false
  private container: HTMLElement
  private resizeObserver: ResizeObserver
  private onReady?: () => void

  constructor(container: HTMLElement, onReady?: () => void) {
    this.container = container
    this.onReady = onReady
    this.engine = new Engine(container)
    this.stage = new Stage(this.engine.renderer.domElement)
    this.characterManager = new CharacterManager(this.stage.scene)
    this.navMesh = new NavMeshManager()
    this.poiManager = new PoiManager()
    this.characterManager.setPoiManager(this.poiManager)
    this.worldManager = new WorldManager(this.stage.scene, this.navMesh, this.poiManager)
    this.visuals = new SceneAgentVisuals(
      () => this.controller,
      () => this.driverManager,
      this.poiManager,
      (index) => {
        this.selectedIndex = index
      }
    )

    this.frame = new SceneFrame(
      this.engine,
      this.stage,
      this.container,
      () => this.controller,
      () => this.driverManager,
      () => this.selectedIndex
    )

    this.bindings = new SceneStoreBindings(
      () => this.controller,
      () => this.driverManager,
      this.visuals,
      (set) => {
        this.reinitializeSimulation(set)
        this.worldManager.updateThemeColor(set.color)
        if (this.controller) {
          this.controller.setColors()
          this.controller.warpAllToSpawn(
            set.user.index,
            getAllAgents(set).map((a) => a.index)
          )
        }
      },
      (index) => {
        this.selectedIndex = index
      }
    )

    this.resizeObserver = new ResizeObserver(() => this.onResize())
    this.resizeObserver.observe(container)

    const activeSet = getActiveAgentSet()
    this.simulation = new AgentSimulation(activeSet)
    this.setCoreHandler((idx, text) => this.simulation!.handleUserMessage(idx, text))

    this.init()
    this.unsubs.push(this.bindings.watchCore())
  }

  public resyncTasks(): void {
    this.bindings.resyncTasks()
  }

  private async init() {
    try {
      await this.engine.init()
      if (this.isDisposed) {
        return
      }

      // Load the 3D world + characters FIRST. The FleetBridge poller is started
      // only after this resolves (see onReady below): in some headless/WebGPU
      // browsers a burst of concurrent fetches starves the large GLB downloads,
      // so we let the scene assets win the network before polling begins.
      await this.worldManager.load()
      await this.characterManager.load()
      if (this.isDisposed) {
        return
      }

      const state = useUiStore.getState()
      this.characterManager.setInstanceCount(state.instanceCount)
      this.controller = new CharacterController(
        this.characterManager,
        this.navMesh,
        this.poiManager
      )
      this.driverManager = new DriverManager(this.controller)

      const activeSet = getActiveAgentSet()
      const playerIndex = activeSet.user.index
      this.driverManager.registerPlayer(playerIndex)

      getAllAgents(activeSet).forEach((agent) => {
        if (agent.index !== playerIndex) {
          this.driverManager!.registerNpc(agent.index, agent)
        }
      })

      new InputManager(
        this.engine.renderer.domElement,
        this.stage.camera,
        () => this.controller!.getCPUPositions(),
        () => this.controller!.getCount(),
        (idx) => {
          if (useUiStore.getState().isChatting) {
            useUiStore.getState().setChatting(false)
          }
          this.selectedIndex = idx !== activeSet.user.index ? idx : null
          useUiStore.getState().setSelectedNpc(this.selectedIndex)
        },
        (x, z) => this.driverManager?.getPlayerDriver().onFloorClick(x, z),
        (idx, pos) => useUiStore.getState().setHoveredNpc(idx, pos),
        () => this.poiManager.getAllPois(),
        (id, label, pos) => useUiStore.getState().setHoveredPoi(id, label, pos),
        (id) => this.driverManager?.getPlayerDriver().onPoiClick(id),
        this.worldManager.getOffice() ?? undefined,
        (p) => this.navMesh.isPointOnNavMesh(p)
      )

      this.engine.renderer.setAnimationLoop(this.frame.animate.bind(this.frame))

      // The FleetBridge may have pushed live tasks into the store before the
      // controller existed; replay them now that the scene is ready.
      this.resyncTasks()

      this.unsubs.push(this.bindings.watchUi())

      // Scene is fully mounted + rendering — safe to start the live data poller.
      if (!this.isDisposed) {
        this.onReady?.()
      }
    } catch (err) {
      console.error('[Office] scene init failed:', err)
      // Even if the 3D failed, let the data panels come to life.
      if (!this.isDisposed) {
        this.onReady?.()
      }
    }
  }

  /** Re-read theme-dependent scene colours (the 3D world is outside CSS). */
  public applyTheme(): void {
    this.stage.applyTheme()
  }

  public startChat(_npcIndex: number): void {
    useUiStore.getState().setChatting(true)
  }

  public async sendMessage(text: string): Promise<void> {
    const { selectedNpcIndex, isThinking } = useUiStore.getState()
    if (selectedNpcIndex === null || isThinking) {
      return
    }
    useCoreStore.setState((s) => ({
      agentHistories: {
        ...s.agentHistories,
        [selectedNpcIndex!]: [
          ...(s.agentHistories[selectedNpcIndex!] || []),
          { role: 'user', content: text }
        ]
      }
    }))
    useUiStore.setState({ isThinking: true, isTyping: false })
    try {
      if (this.coreHandler) {
        await this.coreHandler(selectedNpcIndex!, text)
      }
      useUiStore.setState({ isThinking: false })
    } catch (err) {
      console.error('[SceneManager] sendMessage error:', err)
      useUiStore.setState({ isThinking: false })
    }
  }

  private reinitializeSimulation(activeSet: AgenticSystem) {
    if (this.simulation) {
      this.simulation.dispose()
    }
    this.simulation = new AgentSimulation(activeSet)
    this.setCoreHandler((idx, text) => this.simulation!.handleUserMessage(idx, text))
    if (this.driverManager) {
      const playerIndex = activeSet.user.index
      this.driverManager.dispose()
      this.driverManager.registerPlayer(playerIndex)
      getAllAgents(activeSet).forEach((a) => {
        if (a.index !== playerIndex) {
          this.driverManager!.registerNpc(a.index, a)
        }
      })
    }
  }
  public setCoreHandler(
    handler: ((npcIndex: number, text: string) => Promise<string | null>) | null
  ): void {
    this.coreHandler = handler
  }

  public getLeadBrain() {
    if (!this.simulation) {
      return null
    }
    const set = getActiveAgentSet()
    const lead = this.simulation.getAgent(set.leadAgent.index)
    return lead?.brain || null
  }

  public setNpcWorking(index: number, working: boolean): void {
    this.visuals.setNpcWorking(index, working)
  }
  public setNpcTalking(index: number, talking: boolean): void {
    this.visuals.setNpcTalking(index, talking)
  }
  public moveNpcToBoardroom(index: number): void {
    this.visuals.moveNpcToBoardroom(index)
  }
  public moveNpcToSpawn(index: number, onArrival?: () => void): void {
    this.visuals.moveNpcToSpawn(index, onArrival)
  }

  private onResize() {
    const w = this.container.clientWidth,
      h = this.container.clientHeight
    if (w === 0 || h === 0) {
      return
    }
    this.stage.onResize(w, h)
    if (!useCoreStore.getState().isResizing) {
      this.engine.onResize(w, h)
    }
  }

  public resetScene() {
    if (!this.controller) {
      return
    }
    useUiStore.getState().setChatting(false)
    const set = getActiveAgentSet()
    getAllAgents(set).forEach((a) => this.controller?.setSpeaking(a.index, false))
    this.controller.warpAllToSpawn(
      set.user.index,
      getAllAgents(set).map((a) => a.index)
    )
    this.stage.setFollowTarget(null)
    this.stage.setChatMode(false, false)
  }

  public dispose() {
    this.isDisposed = true
    this.resizeObserver.disconnect()
    this.unsubs.forEach((u) => u())
    this.driverManager?.dispose()
    this.engine.dispose()
  }
}
