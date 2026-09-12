/** Column-major 4x4 matrices for the camera, in WebGPU's 0..1 clip depth. */

export type Vec3 = readonly [number, number, number]

export function perspective(fovY: number, aspect: number, near: number, far: number) {
  const f = 1 / Math.tan(fovY / 2)
  const m = new Float32Array(16)
  m[0] = f / aspect
  m[5] = f
  m[10] = far / (near - far)
  m[11] = -1
  m[14] = (near * far) / (near - far)
  return m
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / length, v[1] / length, v[2] / length]
}

export function lookAt(eye: Vec3, target: Vec3, up: Vec3) {
  const z = normalize(sub(eye, target))
  const x = normalize(cross(up, z))
  const y = cross(z, x)
  const m = new Float32Array(16)
  m[0] = x[0]
  m[1] = y[0]
  m[2] = z[0]
  m[4] = x[1]
  m[5] = y[1]
  m[6] = z[1]
  m[8] = x[2]
  m[9] = y[2]
  m[10] = z[2]
  m[12] = -dot(x, eye)
  m[13] = -dot(y, eye)
  m[14] = -dot(z, eye)
  m[15] = 1
  return m
}

/** An orthonormal camera frame, forward from the eye toward the target. */
export type Basis = { forward: Vec3; right: Vec3; up: Vec3 }

/**
 * The camera as three axes rather than a matrix. A raymarch builds each ray
 * from these directly, so it never needs a projection or its inverse. Looking
 * straight along the given up vector leaves the cross product undefined, so a
 * different axis is borrowed for that frame rather than returning zeros.
 */
export function cameraBasis(eye: Vec3, target: Vec3, up: Vec3): Basis {
  const forward = normalize(sub(target, eye))
  const reference = Math.abs(dot(forward, normalize(up))) > 0.999 ? ([0, 0, 1] as Vec3) : up
  const right = normalize(cross(forward, reference))
  return { forward, right, up: cross(right, forward) }
}

/** a * b, both column-major. */
export function multiply(a: Float32Array, b: Float32Array, out = new Float32Array(16)) {
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0
      for (let k = 0; k < 4; k++) sum += (a[k * 4 + row] ?? 0) * (b[column * 4 + k] ?? 0)
      out[column * 4 + row] = sum
    }
  }
  return out
}

/** Apply a column-major matrix to a point, returning clip coordinates. */
export function transform(m: Float32Array, p: Vec3) {
  const out = [0, 0, 0, 0]
  for (let row = 0; row < 4; row++) {
    out[row] =
      (m[row] ?? 0) * p[0] +
      (m[4 + row] ?? 0) * p[1] +
      (m[8 + row] ?? 0) * p[2] +
      (m[12 + row] ?? 0)
  }
  return out as [number, number, number, number]
}
