// One step of the particle flow field. Each particle rides a curl-noise
// field, is pulled toward three orbiting attractors by bass, kicked outward
// by a beat, jittered by treble, and sped up by energy.

@group(0) @binding(2) var<storage, read_write> particles: array<Particle>;

// Simplex noise by Ashima Arts and Stefan Gustavson, MIT licence
// (https://github.com/ashima/webgl-noise), ported to WGSL.
fn mod289v3(x: vec3<f32>) -> vec3<f32> { return x - floor(x * (1.0 / 289.0)) * 289.0; }
fn mod289v4(x: vec4<f32>) -> vec4<f32> { return x - floor(x * (1.0 / 289.0)) * 289.0; }
fn permute(x: vec4<f32>) -> vec4<f32> { return mod289v4(((x * 34.0) + 1.0) * x); }
fn taylorInvSqrt(r: vec4<f32>) -> vec4<f32> { return 1.79284291400159 - 0.85373472095314 * r; }

fn snoise(v: vec3<f32>) -> f32 {
  let C = vec2<f32>(1.0 / 6.0, 1.0 / 3.0);
  let D = vec4<f32>(0.0, 0.5, 1.0, 2.0);
  var i = floor(v + dot(v, C.yyy));
  let x0 = v - i + dot(i, C.xxx);
  let g = step(x0.yzx, x0.xyz);
  let l = 1.0 - g;
  let i1 = min(g.xyz, l.zxy);
  let i2 = max(g.xyz, l.zxy);
  let x1 = x0 - i1 + C.xxx;
  let x2 = x0 - i2 + C.yyy;
  let x3 = x0 - D.yyy;
  i = mod289v3(i);
  let p = permute(permute(permute(i.z + vec4<f32>(0.0, i1.z, i2.z, 1.0))
    + i.y + vec4<f32>(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4<f32>(0.0, i1.x, i2.x, 1.0));
  let n_ = 0.142857142857;
  let ns = n_ * D.wyz - D.xzx;
  let j = p - 49.0 * floor(p * ns.z * ns.z);
  let x_ = floor(j * ns.z);
  let y_ = floor(j - 7.0 * x_);
  let x = x_ * ns.x + ns.yyyy;
  let y = y_ * ns.x + ns.yyyy;
  let h = 1.0 - abs(x) - abs(y);
  let b0 = vec4<f32>(x.xy, y.xy);
  let b1 = vec4<f32>(x.zw, y.zw);
  let s0 = floor(b0) * 2.0 + 1.0;
  let s1 = floor(b1) * 2.0 + 1.0;
  let sh = -step(h, vec4<f32>(0.0));
  let a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  let a1 = b1.xzyw + s1.xzyw * sh.zzww;
  var p0 = vec3<f32>(a0.xy, h.x);
  var p1 = vec3<f32>(a0.zw, h.y);
  var p2 = vec3<f32>(a1.xy, h.z);
  var p3 = vec3<f32>(a1.zw, h.w);
  let norm = taylorInvSqrt(vec4<f32>(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 = p0 * norm.x;
  p1 = p1 * norm.y;
  p2 = p2 * norm.z;
  p3 = p3 * norm.w;
  var m = max(0.6 - vec4<f32>(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), vec4<f32>(0.0));
  m = m * m;
  return 42.0 * dot(m * m, vec4<f32>(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

fn potential(p: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    snoise(p),
    snoise(p + vec3<f32>(31.416, 47.853, 12.793)),
    snoise(p + vec3<f32>(-233.145, -113.21, 17.5)),
  );
}

// Curl of the noise potential by central differences: divergence free, so
// particles swirl instead of piling up.
fn curl(p: vec3<f32>) -> vec3<f32> {
  let e = 0.05;
  let dx = vec3<f32>(e, 0.0, 0.0);
  let dy = vec3<f32>(0.0, e, 0.0);
  let dz = vec3<f32>(0.0, 0.0, e);
  let px0 = potential(p - dx);
  let px1 = potential(p + dx);
  let py0 = potential(p - dy);
  let py1 = potential(p + dy);
  let pz0 = potential(p - dz);
  let pz1 = potential(p + dz);
  let x = (py1.z - py0.z) - (pz1.y - pz0.y);
  let y = (pz1.x - pz0.x) - (px1.z - px0.z);
  let z = (px1.y - px0.y) - (py1.x - py0.x);
  return vec3<f32>(x, y, z) / (2.0 * e);
}

fn hash(x0: u32) -> u32 {
  var x = x0;
  x = x ^ (x >> 16u);
  x = x * 0x7feb352du;
  x = x ^ (x >> 15u);
  x = x * 0x846ca68bu;
  x = x ^ (x >> 16u);
  return x;
}

fn rand(seed: u32) -> f32 {
  return f32(hash(seed)) * (1.0 / 4294967296.0);
}

fn rand3(seed: u32) -> vec3<f32> {
  return vec3<f32>(rand(seed), rand(seed ^ 0x9e3779b9u), rand(seed ^ 0x3c6ef372u));
}

// A fresh particle somewhere in a ball around the origin.
fn spawn(id: u32, salt: u32) -> Particle {
  let seed = id * 747796405u + salt * 2891336453u;
  let r = rand3(seed);
  let theta = r.x * 6.2831853;
  let z = r.y * 2.0 - 1.0;
  let ring = sqrt(max(0.0, 1.0 - z * z));
  let direction = vec3<f32>(ring * cos(theta), ring * sin(theta), z);
  let radius = 1.8 * pow(r.z, 1.0 / 3.0);
  var p: Particle;
  p.position = direction * radius;
  p.velocity = rand3(seed ^ 0x1234567u) * 0.4 - 0.2;
  p.life = 2.0 + 5.0 * rand(seed ^ 0x77777u);
  p.seed = rand(seed ^ 0xabcdefu);
  return p;
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let id = gid.x;
  if (id >= params.count) {
    return;
  }
  let time = features.clock.x;
  let dt = features.clock.y;
  let bass = max(features.bands.x, features.bands.y);
  let treble = features.levels.x;
  let energy = features.levels.y;
  let beat = features.beat.z;
  let frame = u32(time * 60.0);
  var p = particles[id];

  if (params.reset == 1u) {
    p = spawn(id, 1u);
    // Stagger the first lives so the field does not respawn all at once.
    p.life = p.life * rand(id ^ 0x5555u);
    particles[id] = p;
    return;
  }

  if (p.life <= 0.0) {
    // Emission follows energy: in a quiet passage most dead particles wait.
    if (rand(id ^ hash(frame)) < 0.15 + energy * 0.85) {
      p = spawn(id, frame);
    } else {
      p.life = 0.0;
      particles[id] = p;
      return;
    }
  }

  let frequency = 0.7 + treble * 1.6;
  let flow = curl(p.position * frequency + vec3<f32>(0.0, time * 0.08, time * 0.05));
  var accel = flow * (0.9 + energy * 1.3);

  // Three attractors circle the middle; bass pulls toward them.
  for (var k = 0u; k < 3u; k = k + 1u) {
    let phase = time * 0.35 + f32(k) * 2.0943951;
    let attractor = vec3<f32>(cos(phase), sin(phase * 0.7) * 0.6, sin(phase)) * 0.8;
    let d = attractor - p.position;
    let dist2 = max(dot(d, d), 0.16);
    accel = accel + d * (bass * bass * 1.5 / (dist2 * sqrt(dist2)));
  }

  // A beat pushes everything outward from the middle.
  let radial = normalize(p.position + vec3<f32>(0.0001, 0.0002, 0.0003));
  accel = accel + radial * beat * 7.0;
  // Treble adds jitter.
  accel = accel + (rand3(id ^ hash(frame + 977u)) - 0.5) * treble * 4.0;
  // A gentle spring keeps the cloud together.
  accel = accel - p.position * 0.15;

  let drag = 1.0 - min(1.0, 1.4 * dt);
  var v = p.velocity * drag + accel * dt;
  let speed = length(v);
  if (speed > 3.0) {
    v = v * (3.0 / speed);
  }
  p.velocity = v;
  p.position = p.position + v * dt * (0.7 + energy * 0.8);
  p.life = p.life - dt;
  if (dot(p.position, p.position) > 12.0) {
    p.life = 0.0;
  }
  particles[id] = p;
}
