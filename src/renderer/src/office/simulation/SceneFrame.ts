import * as THREE from 'three/webgpu'
import { getActiveAgentSet } from '../integration/store/teamStore'
import { useUiStore } from '../integration/store/uiStore'
import { AgentBehavior } from '../types'
import type { CharacterController } from './CharacterController'
import { BUBBLE_Y_OFFSET } from './constants'
import type { Engine } from './core/Engine'
import type { Stage } from './core/Stage'
import type { DriverManager } from './drivers/DriverManager'

export class SceneFrame {
  constructor(
    private readonly engine: Engine,
    private readonly stage: Stage,
    private readonly container: HTMLElement,
    private readonly getController: () => CharacterController | null,
    private readonly getDriverManager: () => DriverManager | null,
    private readonly getSelectedIndex: () => number | null
  ) {}

  private get controller() {
    return this.getController()
  }
  private get driverManager() {
    return this.getDriverManager()
  }
  private get selectedIndex() {
    return this.getSelectedIndex()
  }

  public animate() {
    this.engine.timer.update()
    const delta = this.engine.timer.getDelta()
    this.stage.update()
    this.controller?.update(delta, this.engine.renderer)
    this.controller?.syncFromGPU(this.engine.renderer).then((pos) => {
      if (!pos || !this.controller) {
        return
      }
      this.controller.updatePaths(pos)
      this.driverManager?.update(pos, delta)
      this.updateTransparency(pos, delta)
    })
    const player = getActiveAgentSet().user.index
    this.stage.setFollowTarget(
      this.controller?.getCPUPosition(this.selectedIndex ?? player) ?? null
    )
    const { selectedNpcIndex, setSelectedPosition, selectedPosition } = useUiStore.getState()
    const npcScreenPositions: Record<number, { x: number; y: number }> = {}
    const rect = this.container.getBoundingClientRect()
    if (this.controller) {
      for (let i = 0; i < this.controller.getCount(); i++) {
        const p = this.controller.getCPUPosition(i)
        if (p) {
          const s = p.clone()
          s.y += BUBBLE_Y_OFFSET
          s.project(this.stage.camera)
          npcScreenPositions[i] = {
            x: (s.x * 0.5 + 0.5) * rect.width,
            y: (s.y * -0.5 + 0.5) * rect.height
          }
        }
      }
      useUiStore.setState({ npcScreenPositions })
    }
    if (selectedNpcIndex !== null && npcScreenPositions[selectedNpcIndex]) {
      const p = npcScreenPositions[selectedNpcIndex]
      if (
        Math.abs(p.x - (selectedPosition?.x ?? 0)) > 0.5 ||
        Math.abs(p.y - (selectedPosition?.y ?? 0)) > 0.5
      ) {
        setSelectedPosition(p)
      }
    } else if (selectedPosition !== null) {
      setSelectedPosition(null)
    }
    this.stage.setChatMode(
      useUiStore.getState().isChatting,
      this.controller?.getAgentState(player) === AgentBehavior.GOTO
    )
    this.engine.render(this.stage.scene, this.stage.camera)
  }

  private updateTransparency(pos: Float32Array, delta: number) {
    if (!this.controller) {
      return
    }
    const count = this.controller.getCount(),
      buffer = this.controller.getAgentStateBuffer()
    if (!buffer) {
      return
    }
    for (let i = 0; i < count; i++) {
      let overlap = false
      for (let j = 0; j < count; j++) {
        if (i === j) {
          continue
        }
        if ((pos[i * 4] - pos[j * 4]) ** 2 + (pos[i * 4 + 2] - pos[j * 4 + 2]) ** 2 < 0.36) {
          overlap = true
          break
        }
      }
      const cur = buffer.getAlpha(i),
        tar = overlap ? 0.4 : 1
      if (Math.abs(cur - tar) > 0.01) {
        buffer.setAlpha(i, THREE.MathUtils.lerp(cur, tar, Math.min(delta * 2, 1)))
      }
    }
  }
}
