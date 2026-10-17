import {
  atan,
  attribute,
  cos,
  float,
  Fn,
  If,
  instanceIndex,
  mat3,
  mat4,
  positionLocal,
  sin,
  storage,
  uint,
  vec3,
  vec4
} from 'three/tsl'
import type * as THREE from 'three/webgpu'
import { StorageBufferNode } from 'three/webgpu'

type ScalarNode = THREE.Node<'float'>
type VisibilityNode = THREE.Node<'bool'>
// Native TSL supports these operations; @types/three omits their precise overloads.
type UnsignedMinNode = THREE.Node<'uint'> & {
  min(value: THREE.Node<'uint'>): THREE.Node<'uint'>
}
type ScalarMultipliableMatrixNode = THREE.StorageArrayElementNode<'mat4'> & {
  mul(value: ScalarNode): THREE.Node<'mat4'>
}
type MatrixAccumulatorNode = THREE.VarNode<'mat4'> & {
  addAssign(value: THREE.Node<'mat4'>): THREE.Node<'mat4'>
}
// Preserve the existing single-number construction, including its matrix contents.
const legacyMat4 = mat4 as typeof mat4 & ((value: number) => THREE.Node<'mat4'>)

export type CharacterShaderBuffers = {
  positionStorage: THREE.StorageBufferNode<'vec4'>
  velocityStorage: THREE.StorageBufferNode<'vec4'>
  agentStorage: THREE.StorageBufferNode<'vec4'>
  bakedAnimationsBuffer: THREE.StorageBufferAttribute | null
  metaBuffer: THREE.StorageBufferAttribute | null
  numBones: number
  uTime: THREE.UniformNode<'float', number>
  uSpeed: THREE.UniformNode<'float', number>
  instanceCount: number
}

export function createCharacterComputeNode(buffers: CharacterShaderBuffers) {
  return Fn(() => {
    const index = instanceIndex
    const posElement = buffers.positionStorage.element(index)
    const velElement = buffers.velocityStorage.element(index)
    const agentData = buffers.agentStorage.element(index.mul(2))
    const agentState = agentData.w
    const pos = posElement.xyz.toVar()
    const isGoto = agentState.greaterThan(float(0.5)).and(agentState.lessThan(float(1.5)))

    If(isGoto, () => {
      const waypointXZ = vec3(agentData.x, float(0), agentData.z)
      const toTarget = waypointXZ.sub(pos)
      const dist = toTarget.length()
      If(dist.greaterThan(float(0.2)), () => {
        const gotoVel = toTarget.normalize().mul(buffers.uSpeed.mul(3))
        velElement.assign(vec4(gotoVel, 0))
        posElement.assign(vec4(pos.add(gotoVel), 1))
      }).Else(() => {
        // CPU transitions to IDLE after snapping to the waypoint.
        posElement.assign(vec4(agentData.x, pos.y, agentData.z, 1))
      })
    }).Else(() => {
      // Idle and seated characters use facingOverride instead of stale velocity.
      velElement.assign(vec4(float(0), float(0), float(0), float(0)))
      posElement.assign(vec4(pos, 1))
    })
  })().compute(buffers.instanceCount)
}

export function createCharacterVertexNode(
  buffers: CharacterShaderBuffers,
  isVisibleNode: VisibilityNode
) {
  return Fn(() => {
    const instancePos = buffers.positionStorage.element(instanceIndex).xyz
    const rawVel = buffers.velocityStorage.element(instanceIndex).xyz
    const agentData = buffers.agentStorage.element(instanceIndex.mul(2))
    const animParams = buffers.agentStorage.element(instanceIndex.mul(2).add(1))
    const isMoving = rawVel.length().greaterThan(float(0.01))
    const facingOverride = vec3(agentData.x, float(0), agentData.z)
    const hasFacingOverride = facingOverride.length().greaterThan(float(0))
    const facing = vec3(0, 0, 1).toVar()

    If(isMoving, () => {
      facing.assign(rawVel)
    }).ElseIf(hasFacingOverride, () => {
      facing.assign(facingOverride)
    })

    const angle = atan(facing.z, facing.x)
      .negate()
      .add(float(Math.PI / 2))
    const rotationMat = mat3(
      vec3(cos(angle), float(0), sin(angle).negate()),
      vec3(float(0), float(1), float(0)),
      vec3(sin(angle), float(0), cos(angle))
    )
    const finalPosition = positionLocal.toVar()

    if (buffers.bakedAnimationsBuffer && buffers.metaBuffer) {
      const animBuffer = new StorageBufferNode<'mat4'>(
        buffers.bakedAnimationsBuffer,
        'mat4',
        buffers.bakedAnimationsBuffer.count
      )
      const metaStorage = storage(buffers.metaBuffer, 'vec4', buffers.metaBuffer.count)
      const animIndex = agentData.y.toUint()
      const meta = metaStorage.element(animIndex)
      const animOffset = uint(meta.x)
      const numFrames = uint(meta.y)
      const duration = float(meta.z)
      const startTime = animParams.x
      const loopMode = animParams.y
      const animTime = buffers.uTime.sub(startTime).max(0)
      const t = loopMode.greaterThan(0.5)
        ? animTime.div(duration).fract()
        : animTime.div(duration).clamp(0, 1)
      const currentFrame = t.mul(numFrames.toFloat()).toUint() as UnsignedMinNode
      const safeFrame = currentFrame.min(numFrames.sub(uint(1)))
      const skinIndex = attribute<'vec4'>('skinIndex')
      const skinWeight = attribute<'vec4'>('skinWeight')
      const skinMat = legacyMat4(0).toVar() as MatrixAccumulatorNode
      const addInfluence = (boneIdxNode: ScalarNode, weightNode: ScalarNode) => {
        If(weightNode.greaterThan(0), () => {
          const address = animOffset
            .add(safeFrame.mul(uint(buffers.numBones)))
            .add(boneIdxNode.toUint())
          const boneMatrix = animBuffer.element(address) as ScalarMultipliableMatrixNode
          skinMat.addAssign(boneMatrix.mul(weightNode))
        })
      }

      addInfluence(skinIndex.x, skinWeight.x)
      addInfluence(skinIndex.y, skinWeight.y)
      addInfluence(skinIndex.z, skinWeight.z)
      addInfluence(skinIndex.w, skinWeight.w)
      finalPosition.assign(skinMat.mul(vec4(positionLocal, 1)).xyz)
    }

    const vertexScale = isVisibleNode.select(float(1), float(0))
    return rotationMat.mul(finalPosition.mul(vertexScale)).add(instancePos)
  })()
}
