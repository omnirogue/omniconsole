import { uniform } from 'three/tsl'
import * as THREE from 'three/webgpu'
import { getAllAgents } from '../../data/agents'
import { getActiveAgentSet } from '../../integration/store/teamStore'
import type { ExpressionKey, AnimationName } from '../../types'
import { AgentBehavior } from '../../types'
import type { AgentStateBuffer } from '../behavior/AgentStateBuffer'
import type { ExpressionBuffer } from '../behavior/ExpressionBuffer'
import type { PoiManager } from '../world/PoiManager'
import type { CharacterAnimationAssets } from './CharacterAnimationAssets'
import { loadCharacterAnimationAssets } from './CharacterAnimationAssets'
import { createCharacterInstanceBuffers } from './CharacterInstanceBuffers'
import { createCharacterInstancedMeshes } from './CharacterInstancedMeshes'
import type { CharacterShaderBuffers } from './CharacterShaderNodes'
import { createCharacterComputeNode } from './CharacterShaderNodes'

export class CharacterManager {
  private instanceCount = getAllAgents(getActiveAgentSet()).length + 1
  private poiManager: PoiManager | null = null
  private posAttribute: THREE.StorageInstancedBufferAttribute | null = null
  private velAttribute: THREE.StorageInstancedBufferAttribute | null = null
  private agentStateBuffer: AgentStateBuffer | null = null
  private expressionBuffer: ExpressionBuffer | null = null
  private debugPosArray: Float32Array | null = null
  private currentTime = 0
  private uTime = uniform(0)
  private uSpeed = uniform(0.015)
  private computeNode: ReturnType<typeof createCharacterComputeNode> | null = null
  private instancedMeshes: THREE.Mesh[] = []
  private assets: CharacterAnimationAssets | null = null
  public isLoaded = false

  constructor(private scene: THREE.Scene) {}

  public setPoiManager(poiManager: PoiManager) {
    this.poiManager = poiManager
  }

  public async load() {
    try {
      const assets = await loadCharacterAnimationAssets()
      if (!assets) {
        return
      }
      this.assets = assets
      this.initInstances()
      this.isLoaded = true
    } catch (err) {
      console.error('Failed to load character:', err)
    }
  }

  public setInstanceCount(count: number) {
    if (this.instanceCount === count) {
      return
    }
    this.instanceCount = count
    if (this.isLoaded) {
      this.cleanupInstances()
      this.initInstances()
    }
  }

  /** Read positions after renderer.compute(); values may lag by one GPU frame. */
  public async syncFromGPU(renderer: THREE.WebGPURenderer): Promise<Float32Array | null> {
    if (!this.posAttribute) {
      return null
    }
    try {
      const buffer = await renderer.getArrayBufferAsync(this.posAttribute)
      this.debugPosArray = new Float32Array(buffer)
      // Keep CPU writes from uploading stale GPU positions.
      ;(this.posAttribute.array as Float32Array).set(this.debugPosArray)
    } catch {
      // WebGPU readback may be unavailable.
    }
    return this.debugPosArray
  }

  public update(delta: number, renderer: THREE.WebGPURenderer) {
    this.currentTime += delta
    this.uTime.value = this.currentTime
    this.expressionBuffer?.update(delta)
    if (this.computeNode) {
      renderer.compute(this.computeNode)
    }
  }

  private cleanupInstances() {
    for (const mesh of this.instancedMeshes) {
      this.scene.remove(mesh)
    }
    this.instancedMeshes = []
    this.computeNode = null
    this.expressionBuffer = null
  }

  private initInstances() {
    if (!this.assets || this.assets.meshData.length === 0) {
      return
    }
    const buffers = createCharacterInstanceBuffers(
      this.instanceCount,
      this.poiManager,
      this.assets.animationsMeta
    )
    this.posAttribute = buffers.posAttribute
    this.velAttribute = buffers.velAttribute
    this.agentStateBuffer = buffers.agentStateBuffer
    this.expressionBuffer = buffers.expressionBuffer
    this.debugPosArray = buffers.debugPosArray
    const shaderBuffers: CharacterShaderBuffers = {
      positionStorage: buffers.positionStorage,
      velocityStorage: buffers.velocityStorage,
      agentStorage: buffers.agentStateBuffer.storageNode,
      bakedAnimationsBuffer: this.assets.bakedAnimationsBuffer,
      metaBuffer: this.assets.metaBuffer,
      numBones: this.assets.numBones,
      uTime: this.uTime,
      uSpeed: this.uSpeed,
      instanceCount: this.instanceCount
    }
    this.computeNode = createCharacterComputeNode(shaderBuffers)
    const meshes = createCharacterInstancedMeshes(
      this.instanceCount,
      this.assets,
      buffers,
      shaderBuffers
    )
    for (const mesh of meshes) {
      this.scene.add(mesh)
      this.instancedMeshes.push(mesh)
    }
  }

  public getCount() {
    return this.instanceCount
  }

  /** Exposes the agent state buffer so BehaviorManager can read/write states. */
  public getAgentStateBuffer(): AgentStateBuffer | null {
    return this.agentStateBuffer
  }

  /** Returns the current CPU-tracked positions buffer (vec4 stride). Updated each simulateOnCPU call. */
  public getCPUPositions(): Float32Array | null {
    return this.debugPosArray
  }

  /** Returns the world position of a single character from the CPU buffer. */
  public getCPUPosition(index: number): THREE.Vector3 | null {
    if (!this.debugPosArray || index < 0 || index >= this.instanceCount) {
      return null
    }
    const i = index * 4
    return new THREE.Vector3(
      this.debugPosArray[i],
      this.debugPosArray[i + 1],
      this.debugPosArray[i + 2]
    )
  }

  public setPhysicsMode(index: number, mode: AgentBehavior) {
    if (!this.agentStateBuffer || index < 0 || index >= this.instanceCount) {
      return
    }
    this.agentStateBuffer.setState(index, mode)
  }

  /** Teleport an agent to an exact world position by writing directly to the CPU→GPU buffer. */
  public setPosition(index: number, position: THREE.Vector3): void {
    if (!this.posAttribute || index < 0 || index >= this.instanceCount) {
      return
    }
    const arr = this.posAttribute.array as Float32Array
    arr[index * 4 + 0] = position.x
    arr[index * 4 + 1] = position.y
    arr[index * 4 + 2] = position.z
    this.posAttribute.needsUpdate = true
    // Also update the CPU mirror so getCPUPosition() is immediately accurate
    if (this.debugPosArray) {
      this.debugPosArray[index * 4 + 0] = position.x
      this.debugPosArray[index * 4 + 1] = position.y
      this.debugPosArray[index * 4 + 2] = position.z
    }
  }

  /** Teleport an agent and zero their current velocity to avoid sliding. */
  public setPositionAndZeroVelocity(index: number, position: THREE.Vector3): void {
    this.setPosition(index, position)
    if (this.velAttribute && index >= 0 && index < this.instanceCount) {
      const arr = this.velAttribute.array as Float32Array
      arr[index * 4 + 0] = 0
      arr[index * 4 + 1] = 0
      arr[index * 4 + 2] = 0
      arr[index * 4 + 3] = 0
      this.velAttribute.needsUpdate = true
    }
  }

  /** Force a specific facing direction when IDLE. */
  public setFacing(index: number, x: number, z: number) {
    if (!this.agentStateBuffer || index < 0 || index >= this.instanceCount) {
      return
    }
    this.agentStateBuffer.setFacing(index, x, z)
  }

  /** Force a specific orientation based on a quaternion. */
  public setOrientation(index: number, quaternion: THREE.Quaternion) {
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion)
    this.setFacing(index, forward.x, forward.z)
  }

  public getAgentState(index: number): AgentBehavior {
    if (!this.agentStateBuffer || index < 0 || index >= this.instanceCount) {
      return AgentBehavior.IDLE
    }
    return this.agentStateBuffer.getState(index) as AgentBehavior
  }

  public setAnimation(index: number, name: AnimationName, loop: boolean = true) {
    if (this.agentStateBuffer && index >= 0 && index < this.instanceCount) {
      const meta = this.assets?.animationsMeta[name]
      if (meta) {
        this.agentStateBuffer.setAnimation(index, meta.index, loop, this.currentTime)
      }
    }
  }

  public getAnimationIndex(index: number): number {
    if (!this.agentStateBuffer || index < 0 || index >= this.instanceCount) {
      return 0
    }
    return this.agentStateBuffer.getAnimation(index)
  }

  public getAnimationMeta(name: AnimationName) {
    return this.assets?.animationsMeta[name]
  }

  /** Returns the baked clip duration in seconds. Returns 1.0 if the animation is not found. */
  public getAnimationDuration(name: AnimationName): number {
    return this.assets?.animationsMeta[name]?.duration ?? 1
  }

  public setExpression(index: number, name: ExpressionKey) {
    if (this.expressionBuffer) {
      this.expressionBuffer.setExpression(index, name)
    }
  }

  public setSpeaking(index: number, isSpeaking: boolean) {
    if (this.expressionBuffer) {
      this.expressionBuffer.setSpeaking(index, isSpeaking)
    }
    // Note: External logic should handle TALK/IDLE animations
  }

  public setColors() {
    if (this.isLoaded) {
      this.cleanupInstances()
      this.initInstances()
    }
  }
}
