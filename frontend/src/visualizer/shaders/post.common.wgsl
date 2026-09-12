// Shared declarations for the post stack. Prepended to every pass by
// PostStack.ts, so the uniform cannot drift between them. PostParams is the
// block written by writePostUniform in post/params.ts; the layouts must match.

struct PostParams {
  resolution: vec2<f32>,
  texel: vec2<f32>,
  feedback: vec4<f32>,  // amount, decay, zoom, rotate
  bloom: vec4<f32>,     // threshold, knee, intensity, 0
  weights: vec4<f32>,   // level 0, 1, 2, bloom on
  chroma: vec4<f32>,    // split, 0, 0, 0
  tone: vec4<f32>,      // exposure, shoulder, on, 0
  grain: vec4<f32>,     // amount, clock, 0, 0
}

struct Blit {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

// One oversized triangle covers the target; there is no vertex buffer, and a
// triangle beats two of them because the diagonal is never shaded twice.
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
