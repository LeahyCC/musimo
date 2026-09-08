import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import {
  cos,
  cross,
  faceDirection,
  float,
  mix,
  pass,
  positionGeometry,
  sin,
  transformNormalToView,
  uniform,
  uv,
  vec3,
} from 'three/tsl'
import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshPhysicalNodeMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  PointLight,
  Points,
  PointsNodeMaterial,
  RenderPipeline,
  Scene,
  WebGPURenderer,
} from 'three/webgpu'
import type { Node } from 'three/webgpu'

import type { WorldState } from './visualizer-director'

export type VisualSettings = {
  intensity: number
  motion: number
  quality: 'auto' | 'high' | 'low'
  seed: number
  offset: number
  hold: boolean
}

/** A shared parametric surface makes material changes continuous through the whole song. */
export async function createWorld(canvas: HTMLCanvasElement, onFailure: (message: string) => void) {
  const renderer = new WebGPURenderer({ canvas, antialias: true, alpha: false })
  await renderer.init()
  renderer.setClearColor(0x020306, 1)
  renderer.toneMapping = ACESFilmicToneMapping
  renderer.toneMappingExposure = 0.72
  const scene = new Scene()
  const camera = new PerspectiveCamera(42, 1, 0.1, 100)
  camera.position.set(0, 0.2, 8)
  const world = new Group()
  scene.add(world)
  const environment = new RoomEnvironment()
  const pmrem = new PMREMGenerator(renderer)
  const environmentMap = await pmrem.fromSceneAsync(environment, 0.04)
  scene.environment = environmentMap.texture
  scene.environmentIntensity = 0.55
  environment.dispose()
  pmrem.dispose()

  const key = new PointLight(0xb9dfff, 25, 25)
  key.position.set(3, 4, 5)
  const rim = new PointLight(0xf4b77b, 30, 25)
  rim.position.set(-4, 0, 2)
  const violet = new PointLight(0x8573ee, 20, 20)
  violet.position.set(1, -3, -3)
  scene.add(key, rim, violet)

  const clock = uniform(0)
  const low = uniform(0),
    body = uniform(0),
    air = uniform(0),
    impulse = uniform(0)
  const opening = uniform(0.25),
    pressure = uniform(0),
    memory = uniform(0)
  const stereo = uniform(0)
  const identity = uniform(0),
    seed = uniform(0.4),
    intensity = uniform(0.8)
  const geometry = new PlaneGeometry(1, 1, 180, 18)
  const materials: MeshPhysicalNodeMaterial[] = []

  // Displacement and its derivatives are evaluated on the GPU on both rendering backends.
  const surface = (u: Node<'float'>, v: Node<'float'>, layer: number) => {
    const angle = u.mul(Math.PI * 2)
    const offset = float(layer).add(seed.mul(4)).add(identity.mul(0.31))
    const drift = clock.mul(0.075)
    const winding = angle.mul(3).add(offset).add(drift)
    const width = v.sub(0.5).mul(float(0.38).add(opening.mul(0.8)))
    const corrugation = sin(angle.mul(11).sub(clock.mul(0.8)).add(v.mul(9)))
      .mul(air.mul(0.045).add(0.018))
      .mul(intensity)
    const wave = sin(angle.mul(5).sub(clock.mul(1.6)).add(offset))
      .mul(low.mul(0.13).add(impulse.mul(0.07)))
      .mul(intensity)
    const radius = float(1.25)
      .add(opening.mul(0.62))
      .add(cos(winding).mul(float(0.32).add(body.mul(0.3))))
      .add(cos(angle.mul(7).add(offset)).mul(pressure.mul(0.17)))
    const twist = angle.mul(2).add(offset).add(drift.mul(0.7))
    const ribbon = width.add(corrugation).add(wave)
    const spread = radius.add(ribbon.mul(cos(twist)))
    const x = cos(angle.add(offset.mul(0.24))).mul(spread)
    const y = sin(angle.add(offset.mul(0.24))).mul(spread)
    const z = sin(winding)
      .mul(float(0.5).add(opening.mul(0.48)))
      .add(ribbon.mul(sin(twist)))
      .add(sin(angle.mul(2).sub(drift)).mul(opening.mul(0.42)))
    const knot = vec3(
      cos(angle.mul(2).add(offset.mul(0.24))).mul(spread),
      sin(angle.mul(2).add(offset.mul(0.24))).mul(spread),
      z.add(sin(angle.mul(3).add(offset)).mul(0.35)),
    )
    const fold = sin(identity.mul(0.8).add(seed.mul(6)))
      .mul(0.25)
      .add(opening.mul(0.35))
    return mix(vec3(x, y, z), knot, fold).mul(vec3(float(0.92).add(stereo.mul(0.2)), 1, 1))
  }

  for (let i = 0; i < 5; i++) {
    const phase = i * Math.PI * 0.4
    const point = surface(uv().x, uv().y, phase)
    const tangent = surface(uv().x.add(0.001), uv().y, phase).sub(point)
    const bitangent = surface(uv().x, uv().y.add(0.001), phase).sub(point)
    const material = new MeshPhysicalNodeMaterial({
      color: 0xc5d3e4,
      metalness: 0.63,
      roughness: 0.3,
      clearcoat: 1,
      clearcoatRoughness: 0.18,
      iridescence: 1,
      iridescenceIOR: 1.35,
      iridescenceThicknessRange: [180, 520],
      side: DoubleSide,
    })
    material.positionNode = point
    const surfaceNormal = transformNormalToView(cross(tangent, bitangent).normalize()).mul(
      faceDirection,
    )
    material.normalNode = surfaceNormal
    material.clearcoatNormalNode = surfaceNormal
    // Fine interference belongs to the surface, so it follows the folds without a texture seam.
    const grain = sin(
      uv()
        .y.mul(96)
        .add(sin(uv().x.mul(62).sub(clock.mul(0.08))).mul(2)),
    )
      .mul(0.5)
      .add(0.5)
    material.roughnessNode = grain.mul(0.22).add(0.18)
    material.iridescenceThicknessNode = sin(uv().x.mul(28).add(seed.mul(9)))
      .mul(120)
      .add(340)
    const interference = sin(
      uv().x.mul(22).add(uv().y.mul(5)).add(seed.mul(12)).add(clock.mul(0.025)),
    )
      .mul(0.5)
      .add(0.5)
    const cool = vec3(0.18, 0.52, 0.62)
    const warm = vec3(0.52, 0.26, 0.38)
    material.colorNode = mix(cool, warm, interference).mul(0.75)

    material.emissiveNode = mix(vec3(0.09, 0.38, 0.58), vec3(0.52, 0.12, 0.22), interference)
      .mul(air.mul(0.24).add(impulse.mul(0.1)))
      .mul(intensity)
    world.add(new Mesh(geometry, material))
    materials.push(material)
  }

  // Filaments share the ribbon's coordinates, so the same motif survives its material changes.
  const threadGeometry = new PlaneGeometry(1, 1, 220, 1)
  for (let i = 0; i < 14; i++) {
    const phase = i * 0.45
    const material = new MeshPhysicalNodeMaterial({
      color: i % 3 === 0 ? 0xdab683 : 0x83cddd,
      metalness: 0.4,
      roughness: 0.35,
      side: DoubleSide,
      transparent: true,
      opacity: 0.52,
      emissive: i % 3 === 0 ? 0xa07137 : 0x286477,
      emissiveIntensity: 0.7,
    })
    material.positionNode = surface(
      uv().x,
      uv()
        .y.sub(0.5)
        .mul(0.012)
        .add((i % 4) / 3),
      phase,
    ).mul(float(1.08).add(memory.mul(i * 0.013)))
    world.add(new Mesh(threadGeometry, material))
    materials.push(material)
  }

  const dustGeometry = new BufferGeometry()
  const positions = new Float32Array(1800 * 3)
  let random = 17653
  for (let i = 0; i < positions.length; i++) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0
    positions[i] = (random / 4294967296 - 0.5) * 13
  }
  dustGeometry.setAttribute('position', new BufferAttribute(positions, 3))
  const dustMaterial = new PointsNodeMaterial({
    color: 0x8ebac9,
    size: 0.008,
    transparent: true,
    opacity: 0.4,
    depthWrite: false,
    blending: AdditiveBlending,
  })
  dustMaterial.positionNode = positionGeometry.add(
    vec3(
      sin(positionGeometry.y.add(clock.mul(0.045))).mul(0.35),
      cos(positionGeometry.x.add(clock.mul(0.035))).mul(0.3),
      0,
    ),
  )
  scene.add(new Points(dustGeometry, dustMaterial))
  const scenePass = pass(scene, camera)
  const sceneColor = scenePass.getTextureNode('output')
  const glow = bloom(sceneColor, 0.28, 0.35, 0.85)
  const pipeline = new RenderPipeline(renderer, sceneColor.add(glow))
  let disposed = false,
    width = 0,
    height = 0,
    pixelRatio = 0,
    frames = 0
  let averageFrame = 16,
    previousTime = performance.now(),
    resolution = 1.25
  let lastSettings: VisualSettings | null = null

  const lost = () =>
    onFailure('The graphics device paused. Close and reopen Visualize to reconnect.')
  canvas.addEventListener('webglcontextlost', lost)
  renderer.onDeviceLost = lost

  return {
    backend:
      'isWebGPUBackend' in renderer.backend && renderer.backend.isWebGPUBackend
        ? 'WebGPU'
        : 'WebGL 2',
    render(state: WorldState, settings: VisualSettings) {
      if (disposed) return
      const now = performance.now()
      const frameTime = Math.min(100, now - previousTime)
      averageFrame += (frameTime - averageFrame) * 0.025
      previousTime = now
      if (++frames % 180 === 0 && settings.quality === 'auto') {
        if (averageFrame > 24) resolution = Math.max(0.65, resolution - 0.15)
        else if (averageFrame < 17) resolution = Math.min(1.5, resolution + 0.05)
      }
      const rect = canvas.getBoundingClientRect()
      const ratio = Math.min(
        devicePixelRatio || 1,
        settings.quality === 'high' ? 2 : settings.quality === 'low' ? 0.8 : resolution,
      )
      if (rect.width !== width || rect.height !== height || ratio !== pixelRatio) {
        width = Math.max(1, rect.width)
        height = Math.max(1, rect.height)
        pixelRatio = ratio
        renderer.setPixelRatio(ratio)
        renderer.setSize(width, height, false)
        camera.aspect = width / height
        camera.updateProjectionMatrix()
      }
      lastSettings = settings
      clock.value = state.time
      low.value = state.bass
      body.value = state.body
      air.value = state.air
      impulse.value = state.pulse
      opening.value = state.opening
      pressure.value = state.tension
      memory.value = state.memory
      stereo.value = state.width
      identity.value = state.identity
      seed.value = settings.seed
      intensity.value = settings.intensity
      const motion = settings.motion
      world.rotation.set(
        0.6 + Math.sin(state.time * 0.045) * 0.24 * motion,
        Math.sin(state.time * 0.032) * 0.35 * motion,
        state.time * 0.028 * motion,
      )
      const distance =
        (width < height ? 10 : 7.3) - state.opening * 1.8 * settings.intensity + state.tension * 0.4
      camera.position.set(
        Math.sin(state.time * 0.019) * 0.55 * motion,
        0.15 + Math.cos(state.time * 0.024) * 0.45 * motion,
        distance,
      )
      camera.lookAt(0, 0, 0)
      key.intensity = 20 + state.body * 12
      rim.intensity = 20 + state.bass * 10
      violet.intensity = 14 + state.air * 16
      glow.strength.value = 0.22 + settings.intensity * 0.15
      if (settings.quality === 'low') renderer.render(scene, camera)
      else pipeline.render()
    },
    getStats() {
      return {
        fps: Math.round(1000 / averageFrame),
        width: Math.round(width * pixelRatio),
        height: Math.round(height * pixelRatio),
        quality: lastSettings?.quality ?? 'auto',
      }
    },
    dispose() {
      disposed = true
      canvas.removeEventListener('webglcontextlost', lost)
      renderer.setAnimationLoop(null)
      geometry.dispose()
      threadGeometry.dispose()
      dustGeometry.dispose()
      for (const material of materials) material.dispose()
      dustMaterial.dispose()
      environmentMap.dispose()
      pipeline.dispose()
      scenePass.dispose()
      glow.dispose()
      renderer.dispose()
    },
  }
}

export type VisualWorld = Awaited<ReturnType<typeof createWorld>>
