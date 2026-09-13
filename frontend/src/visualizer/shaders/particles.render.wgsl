// Each particle is an instanced quad, additively blended, sized and lit by
// its speed. There is no vertex buffer: the corner comes from vertex_index.
// The size bump, the colour and the brightness all come from params, already
// modulated on the CPU by the preset's mapping.

@group(0) @binding(2) var<storage, read> particles: array<Particle>;

struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) colour: vec3<f32>,
  @location(1) uv: vec2<f32>,
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VertexOut {
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
    vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
  );
  let corner = corners[vi];
  let p = particles[ii];
  let clip = params.camera * vec4<f32>(p.position, 1.0);
  let speed = min(length(p.velocity), 2.5);
  let alive = select(0.0, 1.0, p.life > 0.0);
  // Fade out over the last half second of a life.
  let fade = min(1.0, p.life * 2.0) * alive;
  let size = params.pointSize * (0.7 + speed * 0.5) * params.look.w * alive;
  // size is in pixels; scale to clip space at this depth.
  let offset = corner * size / params.resolution * 2.0 * clip.w;
  var out: VertexOut;
  out.position = clip + vec4<f32>(offset, 0.0, 0.0);
  out.uv = corner;
  let warm = vec3<f32>(1.0, 0.45, 0.15);
  let cool = vec3<f32>(0.2, 0.55, 1.0);
  // The seed spreads the cloud across the ramp, so it is never one flat tint.
  let tint = mix(cool, warm, clamp(params.look.x + p.seed * 0.4, 0.0, 1.0));
  let bright = (params.look.y + speed * params.look.z) * fade * params.intensity;
  out.colour = tint * bright;
  return out;
}

@fragment
fn fs(in: VertexOut) -> @location(0) vec4<f32> {
  let d = dot(in.uv, in.uv);
  let a = max(0.0, 1.0 - d);
  return vec4<f32>(in.colour * a * a, 1.0);
}
