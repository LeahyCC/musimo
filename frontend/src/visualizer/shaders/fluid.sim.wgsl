// The simulation itself: Stam's stable fluids on a square grid, one compute
// entry point per step. Fluid.ts runs them in this order each frame, and
// every pipeline shares one explicit bind group layout so the same three
// textures can be handed to any of them:
//
//   advect_velocity ─► diffuse xN ─► curl ─► forces ─► divergence
//                                                        │
//   advect_dye ◄─ gradient ◄─ pressure xN ◄─ relax ◄──────┘
//
// `srcA` is the field being stepped, `srcB` whatever else the step reads,
// and `dst` is written. Velocity is in grid widths per second, so a
// semi-Lagrangian backtrace is `uv - velocity * dt` with no scaling in
// between, and the pressure solve works on the same units throughout.

@group(0) @binding(2) var srcA: texture_2d<f32>;
@group(0) @binding(3) var srcB: texture_2d<f32>;
@group(0) @binding(4) var dst: texture_storage_2d<rgba16float, write>;

fn outside(id: vec2<u32>) -> bool {
  return id.x >= u32(sim.grid.x) || id.y >= u32(sim.grid.y);
}

/** A neighbour, clamped at the wall so no step reads off the grid. */
fn at(tex: texture_2d<f32>, x: i32, y: i32) -> vec4<f32> {
  let last = vec2<i32>(sim.grid) - vec2<i32>(1, 1);
  return textureLoad(tex, clamp(vec2<i32>(x, y), vec2<i32>(0, 0), last), 0);
}

fn centre(id: vec2<u32>) -> vec2<f32> {
  return (vec2<f32>(id) + vec2<f32>(0.5, 0.5)) * sim.texel;
}

@compute @workgroup_size(8, 8)
fn advect_velocity(@builtin(global_invocation_id) gid: vec3<u32>) {
  let id = gid.xy;
  if (outside(id)) { return; }
  let uv = centre(id);
  let velocity = textureLoad(srcB, vec2<i32>(id), 0).xy;
  let back = textureSampleLevel(srcA, samp, uv - velocity * sim.step.x, 0.0).xy;
  let kept = back * exp(-sim.step.y * sim.step.x);
  textureStore(dst, id, vec4<f32>(kept, 0.0, 1.0));
}

// One Jacobi sweep of the viscosity solve. `srcB` holds the field as it was
// before the sweeps began, which is the right-hand side; `srcA` is the
// current iterate. Alpha is set directly rather than derived from a physical
// viscosity, because the look wanted here is a knob, not a fluid of a
// particular thickness.
@compute @workgroup_size(8, 8)
fn diffuse(@builtin(global_invocation_id) gid: vec3<u32>) {
  let id = gid.xy;
  if (outside(id)) { return; }
  let p = vec2<i32>(id);
  let alpha = sim.mix.x;
  let sum = at(srcA, p.x - 1, p.y).xy + at(srcA, p.x + 1, p.y).xy
          + at(srcA, p.x, p.y - 1).xy + at(srcA, p.x, p.y + 1).xy;
  let base = textureLoad(srcB, p, 0).xy;
  textureStore(dst, id, vec4<f32>((base + alpha * sum) / (1.0 + 4.0 * alpha), 0.0, 1.0));
}

@compute @workgroup_size(8, 8)
fn curl(@builtin(global_invocation_id) gid: vec3<u32>) {
  let id = gid.xy;
  if (outside(id)) { return; }
  let p = vec2<i32>(id);
  let spin = 0.5 * ((at(srcA, p.x + 1, p.y).y - at(srcA, p.x - 1, p.y).y)
                  - (at(srcA, p.x, p.y + 1).x - at(srcA, p.x, p.y - 1).x));
  textureStore(dst, id, vec4<f32>(spin, 0.0, 0.0, 1.0));
}

// Vorticity confinement plus this frame's velocity injections. Confinement
// pushes each eddy back toward its own centre, which is what keeps small
// detail alive against the numerical smearing the advection step adds.
@compute @workgroup_size(8, 8)
fn forces(@builtin(global_invocation_id) gid: vec3<u32>) {
  let id = gid.xy;
  if (outside(id)) { return; }
  let p = vec2<i32>(id);
  var velocity = textureLoad(srcA, p, 0).xy;
  let slope = vec2<f32>(
    abs(at(srcB, p.x + 1, p.y).x) - abs(at(srcB, p.x - 1, p.y).x),
    abs(at(srcB, p.x, p.y + 1).x) - abs(at(srcB, p.x, p.y - 1).x),
  ) * 0.5;
  let toward = slope / max(length(slope), 1e-5);
  let spin = textureLoad(srcB, p, 0).x;
  velocity += vec2<f32>(toward.y, -toward.x) * spin * sim.step.w * sim.step.x;

  let uv = centre(id);
  for (var i = 0u; i < EMITTERS; i = i + 1u) {
    let splat = sim.splats[i];
    velocity += splat.place.zw * splat.drive.x * splatFalloff(splat, uv);
  }

  textureStore(dst, id, vec4<f32>(velocity, 0.0, 1.0));
}

@compute @workgroup_size(8, 8)
fn divergence(@builtin(global_invocation_id) gid: vec3<u32>) {
  let id = gid.xy;
  if (outside(id)) { return; }
  let p = vec2<i32>(id);
  let spread = 0.5 * ((at(srcA, p.x + 1, p.y).x - at(srcA, p.x - 1, p.y).x)
                    + (at(srcA, p.x, p.y + 1).y - at(srcA, p.x, p.y - 1).y));
  textureStore(dst, id, vec4<f32>(spread, 0.0, 0.0, 1.0));
}

// Last frame's pressure is kept as the starting guess, which converges far
// better in the sweeps available than starting from nothing; fading it first
// stops a solution that no longer fits the field from lingering.
@compute @workgroup_size(8, 8)
fn relax(@builtin(global_invocation_id) gid: vec3<u32>) {
  let id = gid.xy;
  if (outside(id)) { return; }
  let kept = textureLoad(srcA, vec2<i32>(id), 0).x * 0.8;
  textureStore(dst, id, vec4<f32>(kept, 0.0, 0.0, 1.0));
}

@compute @workgroup_size(8, 8)
fn pressure(@builtin(global_invocation_id) gid: vec3<u32>) {
  let id = gid.xy;
  if (outside(id)) { return; }
  let p = vec2<i32>(id);
  let sum = at(srcA, p.x - 1, p.y).x + at(srcA, p.x + 1, p.y).x
          + at(srcA, p.x, p.y - 1).x + at(srcA, p.x, p.y + 1).x;
  let spread = textureLoad(srcB, p, 0).x;
  textureStore(dst, id, vec4<f32>((sum - spread) * 0.25, 0.0, 0.0, 1.0));
}

@compute @workgroup_size(8, 8)
fn gradient(@builtin(global_invocation_id) gid: vec3<u32>) {
  let id = gid.xy;
  if (outside(id)) { return; }
  let p = vec2<i32>(id);
  var velocity = textureLoad(srcA, p, 0).xy;
  velocity -= 0.5 * vec2<f32>(
    at(srcB, p.x + 1, p.y).x - at(srcB, p.x - 1, p.y).x,
    at(srcB, p.x, p.y + 1).x - at(srcB, p.x, p.y - 1).x,
  );
  // Free slip at the walls: the component running into one is dropped and
  // the component along it is kept, so a plume slides rather than sticking.
  let last = vec2<u32>(sim.grid) - vec2<u32>(1u, 1u);
  if (id.x == 0u || id.x == last.x) { velocity.x = 0.0; }
  if (id.y == 0u || id.y == last.y) { velocity.y = 0.0; }
  textureStore(dst, id, vec4<f32>(velocity, 0.0, 1.0));
}

// The dye rides the finished velocity field. Its place in the palette travels
// with it as a unit vector rather than a number, so two plumes that meet
// average their colours the short way round instead of sweeping the whole
// palette between them.
@compute @workgroup_size(8, 8)
fn advect_dye(@builtin(global_invocation_id) gid: vec3<u32>) {
  let id = gid.xy;
  if (outside(id)) { return; }
  let uv = centre(id);
  let velocity = textureLoad(srcB, vec2<i32>(id), 0).xy;
  let back = textureSampleLevel(srcA, samp, uv - velocity * sim.step.x, 0.0);
  var density = max(back.x, 0.0) * exp(-sim.step.z * sim.step.x);
  var hue = back.yz;

  for (var i = 0u; i < EMITTERS; i = i + 1u) {
    let splat = sim.splats[i];
    let added = splat.drive.z * splatFalloff(splat, uv);
    density += added;
    let angle = splat.drive.w * TAU;
    hue = mix(hue, vec2<f32>(cos(angle), sin(angle)), clamp(added / max(density, 1e-4), 0.0, 1.0));
  }

  let span = length(hue);
  if (span > 1e-4) { hue = hue / span; }
  textureStore(dst, id, vec4<f32>(density, hue, 1.0));
}
