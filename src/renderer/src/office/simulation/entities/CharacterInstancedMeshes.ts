import { attribute, bool, float, instanceIndex, texture, uv, vec4 } from 'three/tsl'
import * as THREE from 'three/webgpu'
import type { CharacterAnimationAssets } from './CharacterAnimationAssets'
import type { CharacterInstanceBuffers } from './CharacterInstanceBuffers'
import type { CharacterShaderBuffers } from './CharacterShaderNodes'
import { createCharacterVertexNode } from './CharacterShaderNodes'

type CharacterNodeMaterial = {
  uvNode?: THREE.Node<'vec2'>
} & THREE.MeshStandardNodeMaterial

export function createCharacterInstancedMeshes(
  instanceCount: number,
  assets: CharacterAnimationAssets,
  buffers: CharacterInstanceBuffers,
  shaderBuffers: CharacterShaderBuffers
): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = []
  // Reorder meshData: Body FIRST, then features (eyes/mouth)
  // This ensures body writes to depth buffer before features are drawn over it.
  const sortedMeshData = [...assets.meshData].sort((a, b) => {
    const aIsBody = a.name.toLowerCase().includes('body')
    const bIsBody = b.name.toLowerCase().includes('body')
    if (aIsBody && !bIsBody) {
      return -1
    }
    if (!aIsBody && bIsBody) {
      return 1
    }
    return 0
  })

  for (const { name, geometry, material: baseMaterial } of sortedMeshData) {
    const instancedGeometry = new THREE.InstancedBufferGeometry()
    THREE.BufferGeometry.prototype.copy.call(instancedGeometry, geometry)
    instancedGeometry.instanceCount = instanceCount

    // Solo dejamos el atributo que NO se calcula en el Compute Shader
    instancedGeometry.setAttribute('instanceColor', buffers.colorAttribute)
    if (buffers.accessoryAttribute) {
      instancedGeometry.setAttribute('accessoryType', buffers.accessoryAttribute)
    }

    const material: CharacterNodeMaterial = new THREE.MeshStandardNodeMaterial()
    material.roughness = 1
    material.metalness = 0.25

    const instanceColor = attribute<'vec3'>('instanceColor', 'vec3')
    const map = baseMaterial.map

    const expressionData = buffers.expressionBuffer.storageNode.element(instanceIndex)
    const animParams = buffers.agentStateBuffer.storageNode.element(instanceIndex.mul(2).add(1))
    const instanceAlpha = animParams.z
    const accessoryType = attribute<'float'>('accessoryType', 'float')

    const isEyes = name.toLowerCase().includes('eyes')
    const isMouth = name.toLowerCase().includes('mouth')
    const isHeadphones = name.toLowerCase().includes('headphones')
    const isCap = name.toLowerCase().includes('cap')

    const expressionUv = isEyes ? uv().add(expressionData.xy) : uv().add(expressionData.zw)
    if (isEyes) {
      material.uvNode = expressionUv
    } else if (isMouth) {
      material.uvNode = expressionUv
    }

    // Solo coloreamos el mesh cuyo nombre sea 'body' o accesorios
    material.transparent = true

    const isAccessory = isHeadphones || isCap
    const isBody = name.toLowerCase().includes('body')

    const accessoryAlpha = isHeadphones
      ? accessoryType.equal(float(1)).select(instanceAlpha, float(0))
      : accessoryType.equal(float(2)).select(instanceAlpha, float(0))
    if (isHeadphones) {
      material.opacityNode = accessoryAlpha
    } else if (isCap) {
      material.opacityNode = accessoryAlpha
    }

    if (isBody || isAccessory) {
      material.depthWrite = true
      material.depthTest = true

      const baseAlpha = isAccessory
        ? accessoryAlpha
        : map
          ? texture(map).a.mul(instanceAlpha)
          : instanceAlpha

      if (map) {
        const texColor = texture(map)
        material.colorNode = vec4(texColor.rgb.mul(instanceColor), baseAlpha)
      } else {
        material.colorNode = vec4(instanceColor, baseAlpha)
      }
    } else {
      // Eyes / mouth: rendered on top of the body surface with polygon offset to avoid
      // z-fighting, but still respect the depth buffer so they are occluded by walls etc.
      material.depthWrite = false
      material.depthTest = true
      material.polygonOffset = true
      material.polygonOffsetFactor = -1
      material.polygonOffsetUnits = -1

      if (map) {
        const texColor = isEyes || isMouth ? texture(map, expressionUv) : texture(map)
        material.colorNode = vec4(texColor.rgb, texColor.a.mul(instanceAlpha))
      } else {
        material.opacityNode = float(0)
      }
    }

    // Special skinning for static accessories
    if ((isHeadphones || isCap) && assets.headBoneIndex !== -1 && !geometry.attributes.skinIndex) {
      const skinIndices = new Float32Array(geometry.attributes.position.count * 4).fill(
        assets.headBoneIndex
      )
      const skinWeights = new Float32Array(geometry.attributes.position.count * 4).fill(0)
      for (let i = 0; i < geometry.attributes.position.count; i++) {
        skinWeights[i * 4] = 1
      }
      instancedGeometry.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndices, 4))
      instancedGeometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeights, 4))
    }

    const isVisible = isHeadphones
      ? accessoryType.equal(float(1))
      : isCap
        ? accessoryType.equal(float(2))
        : bool(true)
    const vertexNode = createCharacterVertexNode(
      shaderBuffers,
      isVisible.and(instanceAlpha.greaterThan(0))
    )
    material.positionNode = vertexNode
    material.castShadowPositionNode = vertexNode

    const instancedMesh = new THREE.Mesh(instancedGeometry, material)
    instancedMesh.frustumCulled = false
    instancedMesh.castShadow = true
    instancedMesh.receiveShadow = true
    // Body renders first (renderOrder 0), features after (renderOrder 1)
    instancedMesh.renderOrder = name.toLowerCase().includes('body') ? 0 : 1
    meshes.push(instancedMesh)
  }
  return meshes
}
