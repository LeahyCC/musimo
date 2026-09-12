// Shared declarations for the raymarch scene. Prepended to the march by
// Raymarch.ts, so the uniform cannot drift from the block `writeMarchUniform`
// in scenes/raymarch.params.ts fills. Each camera axis carries one scalar in
// its fourth lane, which keeps the whole frame inside eight vec4s.

const TAU: f32 = 6.2831853;

struct March {
  origin: vec4<f32>,   // eye xyz, w = tan of half the vertical field of view
  right: vec4<f32>,    // camera right xyz, w = fold scale
  up: vec4<f32>,       // camera up xyz, w = surface threshold per unit of distance
  forward: vec4<f32>,  // camera forward xyz, w unused
  frame: vec4<f32>,    // march width, height, aspect, 0
  bounds: vec4<f32>,   // step cap, distance cap, fold iterations, step relaxation
  light: vec4<f32>,    // unit direction toward the light xyz, w = strength
  look: vec4<f32>,     // glow, occlusion, palette shift, shadow softness
}

@group(0) @binding(0) var<uniform> march: March;

struct Blit {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

// One oversized triangle covers the target; no vertex buffer, and the
// diagonal two of them share is never shaded twice.
@vertex
fn vs(@builtin(vertex_index) vi: u32) -> Blit {
  var corners = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0),
  );
  let p = corners[vi];
  var out: Blit;
  out.position = vec4<f32>(p, 0.0, 1.0);
  // Clip space is y up, texture coordinates are y down.
  out.uv = vec2<f32>((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5);
  return out;
}
