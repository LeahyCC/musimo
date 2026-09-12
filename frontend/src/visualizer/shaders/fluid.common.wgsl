// Shared declarations for the fluid scene. Prepended to both shaders by
// Fluid.ts, so the uniform cannot drift between the simulation and the pass
// that draws it. `writeSimUniform` in scenes/fluid.params.ts fills this block.

const TAU: f32 = 6.2831853;
const EMITTERS: u32 = 3u;

struct Splat {
  place: vec4<f32>,  // x, y across the grid, then the unit push direction
  drive: vec4<f32>,  // force, radius, dye, palette coordinate
}

struct Sim {
  grid: vec2<f32>,
  texel: vec2<f32>,
  step: vec4<f32>,   // dt, velocity decay, dye decay, vorticity
  mix: vec4<f32>,    // viscosity alpha, colour intensity, 0, 0
  cover: vec4<f32>,  // canvas to grid scale, x and y, then 0, 0
  splats: array<Splat, 3>,
}

@group(0) @binding(0) var<uniform> sim: Sim;
@group(0) @binding(1) var samp: sampler;

/** How much of a splat lands on this point of the grid. */
fn splatFalloff(splat: Splat, uv: vec2<f32>) -> f32 {
  let offset = uv - splat.place.xy;
  return exp(-dot(offset, offset) / (splat.drive.y * splat.drive.y));
}
