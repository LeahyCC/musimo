// WebGL2 renderer for native studies. It owns the canvas context directly, with
// no iframe realm: a study is a manifest of fragment passes, so nothing here
// compiles JavaScript from preset text and the host's globals are never touched.
//
// Determinism: every value a pass can read is either a uniform the engine
// supplies for that media frame or a noise texture generated from the seed at
// load. Nothing in the render path reads Math.random, Date or performance.
import type { BandLevels } from './audio-levels.ts'
import { themeDesat, themeTints } from './studio-options.ts'
import type { ResolvedStudioOptions } from './studio-options.ts'
import {
  DEFAULT_PASS_FORMAT,
  DEFAULT_PASS_SCALE,
  RESERVED_UNIFORM_NAMES,
  settingDefaults,
} from './study-manifest.ts'
import type { StudyManifest, StudyPass } from './study-manifest.ts'

const NOISE_SIZE = 256
// float uniforms are single precision, so a seed above 2^24 would collide with
// its neighbours. Reduce it instead of silently losing the low bits.
const SEED_MODULUS = 0x1000000
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/

export type StudyRenderInput = {
  time: number
  frame: number
  audio: BandLevels
  onset: number
  // Whatever the manifest's frame hook returned for this frame.
  frameUniforms: Readonly<Record<string, number>>
}

// Small deterministic PRNG. Any seeded generator would do; this one is short
// and has no state beyond the seed.
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

const cubic = (y0: number, y1: number, y2: number, y3: number, t: number) => {
  const t2 = t * t
  const a0 = y3 - y2 - y0 + y1
  return a0 * t * t2 + (y0 - y1 - a0) * t2 + (y2 - y0) * t + y1
}

// Port of Butterchurn's Noise.createNoiseTex. zoom > 1 lays a coarse grid and
// cubically interpolates between its points, first across then down, which is
// what makes the mq and hq textures smooth rather than white.
//
// The byte range for a zoomed texture is 216 centred on 108, so the top of the
// range runs past 255 and wraps in the Uint8Array. That wrap is upstream
// behaviour and part of how the texture looks; it is deliberate here, not a slip.
function createNoiseData(size: number, zoom: number, random: () => number): Uint8Array {
  const data = new Uint8Array(size * size * 4)
  const range = zoom > 1 ? 216 : 256
  const half = range * 0.5
  for (let i = 0; i < size * size * 4; i++) data[i] = Math.floor(random() * range + half)
  if (zoom <= 1) return data

  // Both axes read the coarse grid laid down above, wrapping whichever index is
  // walking off the edge. The grid points themselves are never overwritten, so
  // reading and writing the same array is safe.
  const at = (row: number, column: number, channel: number) =>
    data[((row % size) * size + (column % size)) * 4 + channel]
  const interpolate = (
    read: (offset: number) => number,
    t: number,
    row: number,
    column: number,
    channel: number,
  ) => {
    const value = cubic(read(-zoom) / 255, read(0) / 255, read(zoom) / 255, read(zoom * 2) / 255, t)
    data[(row * size + column) * 4 + channel] = Math.min(1, Math.max(0, value)) * 255
  }
  for (let y = 0; y < size; y += zoom) {
    for (let x = 0; x < size; x++) {
      if (x % zoom === 0) continue
      const base = Math.floor(x / zoom) * zoom + size
      for (let c = 0; c < 4; c++)
        interpolate((offset) => at(y, base + offset, c), (x % zoom) / zoom, y, x, c)
    }
  }
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      if (y % zoom === 0) continue
      const base = Math.floor(y / zoom) * zoom + size
      for (let c = 0; c < 4; c++)
        interpolate((offset) => at(base + offset, x, c), (y % zoom) / zoom, y, x, c)
    }
  }
  return data
}

const VERTEX_SOURCE = `#version 300 es
in vec2 position;
out vec2 uv;
out vec2 uv_orig;
void main() {
  uv = position * .5 + .5;
  uv_orig = uv;
  gl_Position = vec4(position, 0., 1.);
}`

// A 9-tap Gaussian folded into five linearly interpolated samples.
const BLUR_SOURCE = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 fragColor;
uniform sampler2D source;
uniform vec2 texelStep;
const float w0 = .2270270270, w1 = .3162162162, w2 = .0702702703;
const float o1 = 1.3846153846, o2 = 3.2307692308;
void main() {
  vec4 sum = texture(source, uv) * w0;
  sum += (texture(source, uv + texelStep * o1) + texture(source, uv - texelStep * o1)) * w1;
  sum += (texture(source, uv + texelStep * o2) + texture(source, uv - texelStep * o2)) * w2;
  fragColor = sum;
}`

const SCALAR_UNIFORMS = [
  'time',
  'frame',
  'onset',
  'seed',
  'bass',
  'mid',
  'treb',
  'vol',
  'bass_att',
  'mid_att',
  'treb_att',
  'vol_att',
  'motion',
  'trails',
  'sensitivity',
  'desat',
] as const

type Surface = {
  texture: WebGLTexture
  framebuffer: WebGLFramebuffer
  width: number
  height: number
}

type CompiledPass = {
  pass: StudyPass
  program: WebGLProgram
  uniforms: Map<string, WebGLUniformLocation>
  samplers: string[]
  surfaces: Surface[]
  read: number
}

export class StudyRenderer {
  readonly floatBuffers: boolean
  private readonly gl: WebGL2RenderingContext
  private readonly canvas: HTMLCanvasElement
  private readonly manifest: StudyManifest
  private readonly passes: CompiledPass[] = []
  private readonly blurLevels: Surface[] = []
  private readonly blurScratch: Surface[] = []
  private readonly noise = new Map<string, WebGLTexture>()
  private readonly scalars = new Map<string, number>()
  private readonly settingValues: Record<string, number>
  private readonly frameKeys: string[]
  private readonly seed: number
  private blurProgram: WebGLProgram | undefined
  private blurUniforms:
    { source: WebGLUniformLocation; texelStep: WebGLUniformLocation } | undefined
  private blurSourceIndex = -1
  private buffer: WebGLBuffer | undefined
  private vao: WebGLVertexArrayObject | undefined
  private options: ResolvedStudioOptions
  private disposed = false

  constructor(
    canvas: HTMLCanvasElement,
    manifest: StudyManifest,
    seed: number,
    options: ResolvedStudioOptions,
  ) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      // Both readPixels after a pause and the studio's clip capture read the
      // drawing buffer outside the frame that drew it.
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    })
    if (!gl) throw new Error('This browser cannot provide WebGL2 for the native renderer.')
    this.gl = gl
    this.canvas = canvas
    this.manifest = manifest
    this.options = options
    this.seed = seed
    this.settingValues = settingDefaults(manifest)
    this.floatBuffers = Boolean(gl.getExtension('EXT_color_buffer_float'))
    if (!this.floatBuffers) {
      console.warn(
        'EXT_color_buffer_float is unavailable; native study buffers fall back to 8-bit.',
      )
    }
    this.frameKeys = this.discoverFrameKeys()
    try {
      this.build()
    } catch (error) {
      this.dispose()
      throw error
    }
  }

  // The shader preamble has to declare every frame-hook uniform, but the hook
  // only names them by returning them. Probe it once at load with idle inputs
  // and a scratch state; the keys of that result are the contract.
  private discoverFrameKeys(): string[] {
    if (!this.manifest.frame) return []
    const idle: BandLevels = {
      bass: 1,
      mid: 1,
      treb: 1,
      vol: 1,
      bassAtt: 1,
      midAtt: 1,
      trebAtt: 1,
      volAtt: 1,
    }
    const probed = this.manifest.frame({
      state: {},
      time: 0,
      frame: 0,
      audio: idle,
      settings: { ...this.settingValues },
      options: this.options,
    })
    return Object.keys(probed)
  }

  private build() {
    const gl = this.gl
    const { manifest } = this
    if (!manifest.passes.length) throw new Error('A study needs at least one pass.')
    if (!manifest.passes.some((pass) => pass.output === 'screen'))
      throw new Error('A study needs a pass that draws to the screen.')

    const names = new Set<string>()
    for (const pass of manifest.passes) {
      if (!IDENTIFIER.test(pass.name) || RESERVED_UNIFORM_NAMES.has(pass.name))
        throw new Error(`Invalid study pass name: ${pass.name}`)
      if (names.has(pass.name)) throw new Error(`Duplicate study pass name: ${pass.name}`)
      names.add(pass.name)
    }
    for (const name of [...Object.keys(this.settingValues), ...this.frameKeys]) {
      if (!IDENTIFIER.test(name) || RESERVED_UNIFORM_NAMES.has(name))
        throw new Error(`Invalid study uniform name: ${name}`)
    }
    if (manifest.blur) {
      this.blurSourceIndex = manifest.passes.findIndex(
        (pass) => pass.name === manifest.blur?.source,
      )
      const source = manifest.passes[this.blurSourceIndex]
      if (!source || source.output !== 'buffer')
        throw new Error('A study blur must name one of its own buffer passes.')
    }

    this.buffer = this.must(gl.createBuffer(), 'vertex buffer')
    this.vao = this.must(gl.createVertexArray(), 'vertex array')
    gl.bindVertexArray(this.vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.bindVertexArray(null)

    const random = mulberry32(this.seed)
    for (const [suffix, zoom] of [
      ['lq', 1],
      ['mq', 4],
      ['hq', 8],
    ] as const) {
      this.noise.set(
        `sampler_noise_${suffix}`,
        this.createNoiseTexture(createNoiseData(NOISE_SIZE, zoom, random)),
      )
    }

    for (const [index, pass] of manifest.passes.entries()) this.compilePass(pass, index)
    if (manifest.blur) this.buildBlur()
    this.setOptions(this.options)
  }

  private must<T>(value: T | null, what: string): T {
    if (value === null) throw new Error(`The native renderer could not create its ${what}.`)
    return value
  }

  private createNoiseTexture(data: Uint8Array): WebGLTexture {
    const gl = this.gl
    const texture = this.must(gl.createTexture(), 'noise texture')
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      NOISE_SIZE,
      NOISE_SIZE,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      data,
    )
    gl.generateMipmap(gl.TEXTURE_2D)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    return texture
  }

  // Half-float is filterable in WebGL2, so buffers stay LINEAR and CLAMP_TO_EDGE.
  // A pass that wants wrapping does it in GLSL.
  private createSurface(width: number, height: number, format: StudyPass['format']): Surface {
    const gl = this.gl
    const float = this.floatBuffers && (format ?? DEFAULT_PASS_FORMAT) === 'rgba16f'
    const texture = this.must(gl.createTexture(), 'pass texture')
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      float ? gl.RGBA16F : gl.RGBA8,
      width,
      height,
      0,
      gl.RGBA,
      float ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE,
      null,
    )
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    const framebuffer = this.must(gl.createFramebuffer(), 'framebuffer')
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
      throw new Error('The native renderer could not complete a render target.')
    // A persistent pass reads this surface on its first frame, so start it black
    // rather than at whatever the driver left in the allocation.
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    return { texture, framebuffer, width, height }
  }

  private samplerNamesFor(index: number): string[] {
    const names = [...this.noise.keys()]
    for (const [other, pass] of this.manifest.passes.entries()) {
      if (pass.output !== 'buffer') continue
      if (other < index || (other === index && pass.persistent)) names.push(`sampler_${pass.name}`)
    }
    if (this.manifest.blur && index > this.blurSourceIndex)
      names.push('sampler_blur1', 'sampler_blur2', 'sampler_blur3')
    return names
  }

  private compilePass(pass: StudyPass, index: number) {
    const gl = this.gl
    const samplers = this.samplerNamesFor(index)
    const scalars = [...SCALAR_UNIFORMS, ...Object.keys(this.settingValues), ...this.frameKeys]
    const source = `#version 300 es
precision highp float;
precision highp int;
in vec2 uv;
in vec2 uv_orig;
out vec4 fragColor;
uniform vec2 resolution;
uniform vec4 aspect;
uniform vec4 texsize;
uniform vec3 tintA;
uniform vec3 tintB;
uniform vec3 tintC;
${scalars.map((name) => `uniform float ${name};`).join('\n')}
${samplers.map((name) => `uniform sampler2D ${name};`).join('\n')}
void main() {
  vec3 ret = vec3(0.);
${pass.glsl}
  fragColor = vec4(ret, 1.);
}`
    const program = this.link(VERTEX_SOURCE, source, pass.name)
    const uniforms = new Map<string, WebGLUniformLocation>()
    for (const name of [
      'resolution',
      'aspect',
      'texsize',
      'tintA',
      'tintB',
      'tintC',
      ...scalars,
      ...samplers,
    ]) {
      const location = gl.getUniformLocation(program, name)
      if (location) uniforms.set(name, location)
    }

    const surfaces: Surface[] = []
    if (pass.output === 'buffer') {
      const scale = pass.scale ?? DEFAULT_PASS_SCALE
      const width = Math.max(1, Math.round(this.canvas.width * scale))
      const height = Math.max(1, Math.round(this.canvas.height * scale))
      surfaces.push(this.createSurface(width, height, pass.format))
      if (pass.persistent) surfaces.push(this.createSurface(width, height, pass.format))
    }
    this.passes.push({ pass, program, uniforms, samplers, surfaces, read: 0 })
  }

  private buildBlur() {
    const gl = this.gl
    this.blurProgram = this.link(VERTEX_SOURCE, BLUR_SOURCE, 'blur')
    this.blurUniforms = {
      source: this.must(gl.getUniformLocation(this.blurProgram, 'source'), 'blur sampler'),
      texelStep: this.must(gl.getUniformLocation(this.blurProgram, 'texelStep'), 'blur step'),
    }
    const source = this.passes[this.blurSourceIndex].surfaces[0]
    for (let level = 1; level <= 3; level++) {
      const width = Math.max(1, source.width >> level)
      const height = Math.max(1, source.height >> level)
      this.blurScratch.push(this.createSurface(width, height, 'rgba16f'))
      this.blurLevels.push(this.createSurface(width, height, 'rgba16f'))
    }
  }

  private link(vertex: string, fragment: string, label: string): WebGLProgram {
    const gl = this.gl
    const program = this.must(gl.createProgram(), 'shader program')
    const shaders: WebGLShader[] = []
    try {
      for (const [type, source] of [
        [gl.VERTEX_SHADER, vertex],
        [gl.FRAGMENT_SHADER, fragment],
      ] as const) {
        const shader = this.must(gl.createShader(type), 'shader')
        shaders.push(shader)
        gl.shaderSource(shader, source)
        gl.compileShader(shader)
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
          throw new Error(`Study pass “${label}” did not compile: ${gl.getShaderInfoLog(shader)}`)
        gl.attachShader(program, shader)
      }
      gl.bindAttribLocation(program, 0, 'position')
      gl.linkProgram(program)
      if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        throw new Error(`Study pass “${label}” did not link: ${gl.getProgramInfoLog(program)}`)
      return program
    } catch (error) {
      gl.deleteProgram(program)
      throw error
    } finally {
      for (const shader of shaders) gl.deleteShader(shader)
    }
  }

  // Studio options are uniforms here, so a slider moves without a rebuild.
  setOptions(options: ResolvedStudioOptions) {
    this.options = options
    this.scalars.set('motion', options.motion)
    this.scalars.set('trails', options.trails)
    this.scalars.set('sensitivity', options.sensitivity)
    this.scalars.set('desat', themeDesat[options.theme])
  }

  setSetting(name: string, value: number) {
    if (!(name in this.settingValues)) throw new Error(`Unknown study setting: ${name}`)
    if (!Number.isFinite(value)) throw new Error('A study setting must be a finite number.')
    this.settingValues[name] = value
  }

  get settings(): Readonly<Record<string, number>> {
    return this.settingValues
  }

  render(input: StudyRenderInput) {
    if (this.disposed) throw new Error('This study renderer has been disposed.')
    const gl = this.gl
    const { audio } = input
    this.scalars.set('time', input.time)
    this.scalars.set('frame', input.frame)
    this.scalars.set('onset', input.onset)
    this.scalars.set('seed', this.seed % SEED_MODULUS)
    this.scalars.set('bass', audio.bass)
    this.scalars.set('mid', audio.mid)
    this.scalars.set('treb', audio.treb)
    this.scalars.set('vol', audio.vol)
    this.scalars.set('bass_att', audio.bassAtt)
    this.scalars.set('mid_att', audio.midAtt)
    this.scalars.set('treb_att', audio.trebAtt)
    this.scalars.set('vol_att', audio.volAtt)
    for (const [name, value] of Object.entries(this.settingValues)) this.scalars.set(name, value)
    for (const name of this.frameKeys) this.scalars.set(name, input.frameUniforms[name] ?? 0)

    gl.bindVertexArray(this.vao ?? null)
    gl.disable(gl.BLEND)
    gl.disable(gl.DEPTH_TEST)
    for (const [index, compiled] of this.passes.entries()) {
      this.drawPass(compiled)
      if (compiled.pass.persistent) compiled.read = 1 - compiled.read
      if (index === this.blurSourceIndex) this.drawBlur()
    }
    gl.bindVertexArray(null)
  }

  private drawPass(compiled: CompiledPass) {
    const gl = this.gl
    const { pass, surfaces } = compiled
    // A persistent pass reads `read` and writes the other half of the pair. The
    // swap after the draw then leaves `read` pointing at what was just written,
    // which is both this frame's output for later passes and the previous frame
    // for this pass on the next tick.
    const target =
      pass.output === 'buffer' ? surfaces[pass.persistent ? 1 - compiled.read : 0] : undefined
    const width = target?.width ?? this.canvas.width
    const height = target?.height ?? this.canvas.height
    gl.bindFramebuffer(gl.FRAMEBUFFER, target?.framebuffer ?? null)
    gl.viewport(0, 0, width, height)
    gl.useProgram(compiled.program)

    const wide = this.canvas.width >= this.canvas.height
    const ratio = wide
      ? this.canvas.height / this.canvas.width
      : this.canvas.width / this.canvas.height
    const uniforms = compiled.uniforms
    const vec2 = uniforms.get('resolution')
    if (vec2) gl.uniform2f(vec2, this.canvas.width, this.canvas.height)
    const aspect = uniforms.get('aspect')
    if (aspect)
      gl.uniform4f(
        aspect,
        wide ? 1 : ratio,
        wide ? ratio : 1,
        wide ? 1 : 1 / ratio,
        wide ? 1 / ratio : 1,
      )
    const texsize = uniforms.get('texsize')
    if (texsize) gl.uniform4f(texsize, width, height, 1 / width, 1 / height)
    const tints = themeTints[this.options.theme]
    for (const [index, name] of (['tintA', 'tintB', 'tintC'] as const).entries()) {
      const location = uniforms.get(name)
      if (location) gl.uniform3f(location, tints[index][0], tints[index][1], tints[index][2])
    }
    for (const [name, value] of this.scalars) {
      const location = uniforms.get(name)
      if (location) gl.uniform1f(location, value)
    }

    let unit = 0
    for (const name of compiled.samplers) {
      const location = uniforms.get(name)
      if (!location) continue
      gl.activeTexture(gl.TEXTURE0 + unit)
      gl.bindTexture(gl.TEXTURE_2D, this.textureFor(name, compiled))
      gl.uniform1i(location, unit)
      unit++
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  // `read` addresses both cases: for the pass currently drawing it is still its
  // previous frame, and for a pass that already drew and swapped it is this
  // frame's output.
  private static current(compiled: CompiledPass): Surface {
    return compiled.surfaces[compiled.pass.persistent ? compiled.read : 0]
  }

  private textureFor(name: string, compiled: CompiledPass): WebGLTexture | null {
    const noise = this.noise.get(name)
    if (noise) return noise
    const blur = /^sampler_blur([123])$/.exec(name)
    if (blur) return this.blurLevels[Number(blur[1]) - 1].texture
    const passName = name.slice('sampler_'.length)
    if (compiled.pass.persistent && passName === compiled.pass.name)
      return StudyRenderer.current(compiled).texture
    const other = this.passes.find((candidate) => candidate.pass.name === passName)
    return other ? StudyRenderer.current(other).texture : null
  }

  // Three progressively smaller separable Gaussians, taken from the source pass
  // straight after it renders so the passes below it see this frame's blur.
  private drawBlur() {
    const gl = this.gl
    if (!this.blurProgram || !this.blurUniforms) return
    gl.useProgram(this.blurProgram)
    gl.uniform1i(this.blurUniforms.source, 0)
    gl.activeTexture(gl.TEXTURE0)
    let input = StudyRenderer.current(this.passes[this.blurSourceIndex]).texture
    for (let level = 0; level < this.blurLevels.length; level++) {
      const scratch = this.blurScratch[level]
      const output = this.blurLevels[level]
      for (const [target, texture, stepX, stepY] of [
        [scratch, input, 1 / scratch.width, 0],
        [output, scratch.texture, 0, 1 / scratch.height],
      ] as const) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer)
        gl.viewport(0, 0, target.width, target.height)
        gl.bindTexture(gl.TEXTURE_2D, texture)
        gl.uniform2f(this.blurUniforms.texelStep, stepX, stepY)
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      }
      input = output.texture
    }
  }

  // Block until the driver has finished preparing the programs and targets, so
  // the engine's warm measurement covers real work rather than queued commands.
  finish() {
    this.gl.finish()
    const error = this.gl.getError()
    if (error !== this.gl.NO_ERROR) throw new Error(`Native study preparation failed (${error}).`)
  }

  // Clear every buffer back to black and rewind the ping-pong. A seek rebuilds
  // its feedback from here, so this is what makes a reconstruction reproducible.
  reset() {
    const gl = this.gl
    for (const compiled of this.passes) {
      compiled.read = 0
      for (const surface of compiled.surfaces) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, surface.framebuffer)
        gl.clearColor(0, 0, 0, 1)
        gl.clear(gl.COLOR_BUFFER_BIT)
      }
    }
    for (const surface of [...this.blurLevels, ...this.blurScratch]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, surface.framebuffer)
      gl.clearColor(0, 0, 0, 1)
      gl.clear(gl.COLOR_BUFFER_BIT)
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  readPixels(): Uint8Array {
    const gl = this.gl
    const { width, height } = this.canvas
    const pixels = new Uint8Array(width * height * 4)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    return pixels
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    const gl = this.gl
    for (const compiled of this.passes) {
      gl.deleteProgram(compiled.program)
      for (const surface of compiled.surfaces) {
        gl.deleteTexture(surface.texture)
        gl.deleteFramebuffer(surface.framebuffer)
      }
    }
    for (const surface of [...this.blurLevels, ...this.blurScratch]) {
      gl.deleteTexture(surface.texture)
      gl.deleteFramebuffer(surface.framebuffer)
    }
    for (const texture of this.noise.values()) gl.deleteTexture(texture)
    if (this.blurProgram) gl.deleteProgram(this.blurProgram)
    if (this.buffer) gl.deleteBuffer(this.buffer)
    if (this.vao) gl.deleteVertexArray(this.vao)
    this.passes.length = 0
    this.blurLevels.length = 0
    this.blurScratch.length = 0
    this.noise.clear()
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}
