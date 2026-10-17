import { storage } from 'three/tsl'
import * as THREE from 'three/webgpu'
import { getAllCharacters } from '../../data/agents'
import { getActiveAgentSet } from '../../integration/store/teamStore'
import type { PoiDef } from '../../types'
import { AgentBehavior, AnimationName } from '../../types'
import { AgentStateBuffer } from '../behavior/AgentStateBuffer'
import { ExpressionBuffer } from '../behavior/ExpressionBuffer'
import type { PoiManager } from '../world/PoiManager'
import type { CharacterAnimationAssets } from './CharacterAnimationAssets'

export function createCharacterInstanceBuffers(
  instanceCount: number,
  poiManager: PoiManager | null,
  animationsMeta: CharacterAnimationAssets['animationsMeta']
) {
  const posArray = new Float32Array(instanceCount * 4)
  const velArray = new Float32Array(instanceCount * 4)
  const colorArray = new Float32Array(instanceCount * 3)
  const accessoryArray = new Float32Array(instanceCount)

  const tempColor = new THREE.Color()
  const spawnRadius = 8 // Default spawn area

  const spawnPois = poiManager?.getFreePoisByPrefix('spawn') || []
  let spawnIndex = 0

  const agentsBuffer: (PoiDef | null)[] = []

  const system = getActiveAgentSet()
  const allCharacters = getAllCharacters(system)

  for (let i = 0; i < instanceCount; i++) {
    const agentNode = allCharacters.find((a) => a.index === i) || system.leadAgent
    const colorOverride = agentNode.color
    tempColor.set(colorOverride)

    if (i === system.user.index) {
      // Player spawns at (0,0,0)
      posArray[i * 4 + 0] = 0
      posArray[i * 4 + 2] = 0
      agentsBuffer[i] = null
    } else {
      const poi = spawnPois[spawnIndex % spawnPois.length]
      if (poi) {
        poiManager?.occupy(poi.id, i)
        posArray[i * 4 + 0] = poi.position.x
        posArray[i * 4 + 2] = poi.position.z
        spawnIndex++
        agentsBuffer[i] = poi
      } else {
        posArray[i * 4 + 0] = (Math.random() - 0.5) * spawnRadius * 2
        posArray[i * 4 + 2] = (Math.random() - 0.5) * spawnRadius * 2
        agentsBuffer[i] = null
      }
      posArray[i * 4 + 3] = 1
      velArray[i * 4 + 0] = (Math.random() - 0.5) * 0.1
      velArray[i * 4 + 2] = (Math.random() - 0.5) * 0.1
    }

    colorArray[i * 3 + 0] = tempColor.r
    colorArray[i * 3 + 1] = tempColor.g
    colorArray[i * 3 + 2] = tempColor.b

    // Accessory logic: 0=None, 1=Headphones, 2=Cap
    if (i === system.user.index) {
      accessoryArray[i] = 0
    } else if (i === system.leadAgent.index) {
      accessoryArray[i] = 1
    } else {
      accessoryArray[i] = 2
    }
  }

  const debugPosArray = new Float32Array(posArray)

  const posAttribute = new THREE.StorageInstancedBufferAttribute(posArray, 4)
  const velAttribute = new THREE.StorageInstancedBufferAttribute(velArray, 4)
  const colorAttribute = new THREE.InstancedBufferAttribute(colorArray, 3)
  const accessoryAttribute = new THREE.InstancedBufferAttribute(accessoryArray, 1)

  const positionStorage = storage(posAttribute, 'vec4', instanceCount)
  const velocityStorage = storage(velAttribute, 'vec4', instanceCount)

  // Physics & state buffer — all start at mode 0 (IDLE)
  const agentStateBuffer = new AgentStateBuffer(instanceCount)
  for (let i = 0; i < instanceCount; i++) {
    agentStateBuffer.setState(i, AgentBehavior.IDLE)

    // Initial animation: start with a random negative time so they are out of sync
    const meta = animationsMeta[AnimationName.IDLE]
    if (meta) {
      agentStateBuffer.setAnimation(i, meta.index, true, -Math.random() * 10)
    }

    // APPLY POI ORIENTATION
    const poi = agentsBuffer[i]
    if (poi && (poi.id.includes('spawn') || poi.id.includes('sit'))) {
      const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(poi.quaternion)
      agentStateBuffer.setFacing(i, forward.x, forward.z)
    }
  }

  const expressionBuffer = new ExpressionBuffer(instanceCount)
  return {
    posAttribute,
    velAttribute,
    colorAttribute,
    accessoryAttribute,
    positionStorage,
    velocityStorage,
    agentStateBuffer,
    expressionBuffer,
    debugPosArray
  }
}

export type CharacterInstanceBuffers = ReturnType<typeof createCharacterInstanceBuffers>
