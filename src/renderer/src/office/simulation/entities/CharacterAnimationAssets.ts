import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import * as THREE from 'three/webgpu'
import { AnimationName } from '../../types'
import { DRACO_LIB_PATH, OFFICE_ASSET_BASE } from '../constants'

export type CharacterAnimationMeta = {
  offset: number
  numFrames: number
  duration: number
  index: number
}

export type CharacterMeshData = {
  name: string
  geometry: THREE.BufferGeometry
  material: THREE.MeshStandardMaterial
}

export type CharacterAnimationAssets = {
  meshData: CharacterMeshData[]
  animationsMeta: Partial<Record<AnimationName, CharacterAnimationMeta>>
  bakedAnimationsBuffer: THREE.StorageBufferAttribute
  metaBuffer: THREE.StorageBufferAttribute
  numBones: number
  headBoneIndex: number
}

function bakeAnimation(mesh: THREE.SkinnedMesh, clip: THREE.AnimationClip, root: THREE.Object3D) {
  const mixer = new THREE.AnimationMixer(root)
  mixer.clipAction(clip).play()
  const skeleton = mesh.skeleton
  const duration = clip.duration
  const numFrames = Math.ceil(duration * 60)
  const numBones = skeleton.bones.length
  const data = new Float32Array(numFrames * numBones * 16)
  for (let f = 0; f < numFrames; f++) {
    mixer.setTime((f / numFrames) * duration)
    root.updateMatrixWorld(true)
    skeleton.update()
    const boneMatrices = skeleton.boneMatrices
    if (!boneMatrices) {
      throw new Error('CharacterManager: Missing skeleton bone matrices.')
    }
    for (let b = 0; b < numBones; b++) {
      const i = (f * numBones + b) * 16
      for (let k = 0; k < 16; k++) {
        data[i + k] = boneMatrices[b * 16 + k]
      }
    }
  }
  return {
    data,
    numFrames,
    duration
  }
}

export async function loadCharacterAnimationAssets(): Promise<CharacterAnimationAssets | null> {
  const loader = new GLTFLoader()
  const dracoLoader = new DRACOLoader()
  dracoLoader.setDecoderPath(DRACO_LIB_PATH)
  loader.setDRACOLoader(dracoLoader)
  // FileLoader supports the desktop application's file:// assets.
  const buf = (await new THREE.FileLoader()
    .setResponseType('arraybuffer')
    .loadAsync(`${OFFICE_ASSET_BASE}models/character.glb`)) as ArrayBuffer
  const gltf = await new Promise<GLTF>((resolve, reject) => loader.parse(buf, '', resolve, reject))
  const model = gltf.scene
  const skinnedMeshes: THREE.SkinnedMesh[] = []
  const allMeshes: THREE.Mesh[] = []
  model.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      allMeshes.push(child)
      if (child instanceof THREE.SkinnedMesh) {
        skinnedMeshes.push(child)
      }
    }
  })
  if (allMeshes.length === 0) {
    console.warn('CharacterManager: No meshes found.')
    return null
  }
  const meshData = allMeshes.map((mesh) => ({
    name: mesh.name,
    geometry: mesh.geometry,
    material: mesh.material as THREE.MeshStandardMaterial
  }))
  const firstSkinnedMesh = skinnedMeshes[0]
  if (!firstSkinnedMesh) {
    throw new Error('CharacterManager: No skinned meshes found.')
  }
  const numBones = firstSkinnedMesh.skeleton.bones.length
  const headBoneIndex = firstSkinnedMesh.skeleton.bones.findIndex(
    (bone) => bone.name.toLowerCase() === 'head'
  )
  const animationsMeta: CharacterAnimationAssets['animationsMeta'] = {}
  const animations = gltf.animations
  const animNames = Object.values(AnimationName)
  const bakedDataList: Float32Array[] = []
  const metaArray = new Float32Array(animNames.length * 4)
  let currentOffset = 0
  animNames.forEach((name, index) => {
    const clip =
      animations.find((animation) => animation.name === name) ||
      (name === AnimationName.IDLE
        ? animations[0]
        : animations.find((animation) => animation.name === AnimationName.IDLE) || animations[0])
    if (!clip) {
      throw new Error('CharacterManager: No animations found.')
    }
    const baked = bakeAnimation(firstSkinnedMesh, clip, model)
    bakedDataList.push(baked.data)
    animationsMeta[name] = {
      offset: currentOffset,
      numFrames: baked.numFrames,
      duration: baked.duration,
      index
    }
    metaArray[index * 4] = currentOffset
    metaArray[index * 4 + 1] = baked.numFrames
    metaArray[index * 4 + 2] = baked.duration
    currentOffset += baked.numFrames * numBones
  })
  const totalSize = bakedDataList.reduce((acc, data) => acc + data.length, 0)
  const combinedData = new Float32Array(totalSize)
  let seek = 0
  for (const data of bakedDataList) {
    combinedData.set(data, seek)
    seek += data.length
  }
  return {
    meshData,
    animationsMeta,
    bakedAnimationsBuffer: new THREE.StorageBufferAttribute(combinedData, 16),
    metaBuffer: new THREE.StorageBufferAttribute(metaArray, 4),
    numBones,
    headBoneIndex
  }
}
