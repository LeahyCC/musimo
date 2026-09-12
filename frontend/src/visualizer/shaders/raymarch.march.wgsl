// The march. One ray a pixel through a Mandelbox distance field, shaded from
// one light with a soft shadow and an occlusion term that costs nothing,
// because it is read off the number of steps the ray already took.
//
// Everything the music drives arrives in the uniform: the fold scale, how many
// times the fold runs, where the camera is and how hard the light burns. The
// two caps below (steps and distance) are the only thing standing between a
// loud passage and a frame that takes a second.

// The inner ball the sphere fold inflates, and the shell it inverts.
const MIN_RADIUS2: f32 = 0.25;
const FIXED_RADIUS2: f32 = 1.0;
// The fold in its own units is about ten across at the corners, which would
// put the camera inside it at any sensible distance. Everything is marched
// through this instead, so the world holds a shape a few units wide.
const SPAN: f32 = 2.6;
// The shadow ray is its own march, so it gets its own, much smaller cap.
const SHADOW_STEPS: i32 = 18;
const SHADOW_FAR: f32 = 5.0;

/**
 * Mandelbox distance estimate. Each round folds the point back into the unit
 * box, inflates it out of the inner ball or inverts it inside the shell, then
 * scales it and adds the point it started from. `dr` carries the running
 * derivative, which is what turns the folded length back into a distance.
 */
fn fold(start: vec3<f32>) -> f32 {
  let scale = march.right.w;
  let rounds = i32(march.bounds.z);
  var p = start;
  var dr = 1.0;
  for (var i = 0; i < rounds; i = i + 1) {
    p = clamp(p, vec3<f32>(-1.0), vec3<f32>(1.0)) * 2.0 - p;
    let r2 = dot(p, p);
    if (r2 < MIN_RADIUS2) {
      let f = FIXED_RADIUS2 / MIN_RADIUS2;
      p = p * f;
      dr = dr * f;
    } else if (r2 < FIXED_RADIUS2) {
      let f = FIXED_RADIUS2 / r2;
      p = p * f;
      dr = dr * f;
    }
    p = p * scale + start;
    dr = dr * abs(scale) + 1.0;
  }

  return length(p) / abs(dr);
}

/** The fold as the march sees it, brought down to a few units across. */
fn field(at: vec3<f32>) -> f32 {
  return fold(at * SPAN) / SPAN;
}

struct Ray {
  distance: f32,
  /** Steps taken as a fraction of the cap, which is the occlusion term. */
  steps: f32,
  landed: bool,
}

fn trace(origin: vec3<f32>, direction: vec3<f32>) -> Ray {
  let cap = i32(march.bounds.x);
  var out: Ray;
  out.distance = 0.02;
  out.steps = 1.0;
  out.landed = false;
  var taken = 0;
  for (var i = 0; i < cap; i = i + 1) {
    taken = i + 1;
    let d = field(origin + direction * out.distance);
    // The threshold grows with the distance run, so detail a long way off
    // costs no more steps than it is worth on screen.
    if (d < march.up.w * out.distance) {
      out.landed = true;
      break;
    }

    out.distance = out.distance + d * march.bounds.w;
    if (out.distance > march.bounds.y) {
      break;
    }
  }

  out.steps = f32(taken) / max(1.0, f32(cap));
  return out;
}

// Four samples on a tetrahedron rather than six on the axes, which is two
// fewer walks through the fold for the same normal.
fn normalAt(p: vec3<f32>, eps: f32) -> vec3<f32> {
  let k = vec2<f32>(1.0, -1.0);
  return normalize(
    k.xyy * field(p + k.xyy * eps) +
    k.yyx * field(p + k.yyx * eps) +
    k.yxy * field(p + k.yxy * eps) +
    k.xxx * field(p + k.xxx * eps)
  );
}

// A shadow ray that keeps the nearest the field came to it: a ray that passed
// close to the fold is half in shadow, so the edge is soft without sampling
// the light more than once.
fn softShadow(origin: vec3<f32>, toLight: vec3<f32>) -> f32 {
  var shade = 1.0;
  var t = 0.03;
  for (var i = 0; i < SHADOW_STEPS; i = i + 1) {
    let d = field(origin + toLight * t);
    if (d < 0.0008) {
      return 0.0;
    }

    shade = min(shade, march.look.w * d / t);
    t = t + clamp(d, 0.02, 0.4);
    if (t > SHADOW_FAR) {
      break;
    }
  }

  return clamp(shade, 0.0, 1.0);
}

// A cosine ramp, deep blue through teal into warm orange and back, so the
// coordinate wraps with no seam.
fn palette(t: f32) -> vec3<f32> {
  let mid = vec3<f32>(0.44, 0.40, 0.46);
  let span = vec3<f32>(0.40, 0.34, 0.38);
  let phase = vec3<f32>(0.0, 0.20, 0.52);
  return mid + span * cos(TAU * (vec3<f32>(t) + phase));
}

@fragment
fn fs(in: Blit) -> @location(0) vec4<f32> {
  let ndc = vec2<f32>(in.uv.x * 2.0 - 1.0, 1.0 - in.uv.y * 2.0);
  let origin = march.origin.xyz;
  let direction = normalize(
    march.forward.xyz
      + march.right.xyz * ndc.x * march.frame.z * march.origin.w
      + march.up.xyz * ndc.y * march.origin.w
  );

  let ray = trace(origin, direction);
  // A ray that ran a long way without landing was grazing the fold, so the
  // step count is also the halo around it. It is the only thing a miss draws,
  // and it is what the bloom picks up.
  let halo = palette(march.look.z + 0.12) * pow(ray.steps, 3.0) * march.look.x * 1.5;
  let sky = vec3<f32>(0.006, 0.010, 0.022) + halo;
  if (!ray.landed) {
    return vec4<f32>(sky, 1.0);
  }

  let point = origin + direction * ray.distance;
  let eps = max(march.up.w * ray.distance, 1e-5);
  let normal = normalAt(point, eps);
  let toLight = march.light.xyz;
  let diffuse = max(dot(normal, toLight), 0.0);
  // A face turned away from the light is in shadow whatever the shadow ray
  // would say, so it does not pay for one. That is half the surface on a
  // convex fold and it is the second most expensive thing in the pass. The
  // ray starts off the surface, or it lands on the surface it left.
  var shade = 0.0;
  if (diffuse > 0.0) {
    shade = softShadow(point + normal * eps * 4.0, toLight);
  }

  let occlusion = clamp(1.0 - ray.steps * march.look.y, 0.2, 1.0);
  // Colour runs with how deep in the fold the surface sits and how much the
  // ray had to scrape to reach it, so a face and the filigree on it are not
  // the same flat tint.
  let tint = palette(march.look.z + length(point) * 0.12 + ray.steps * 0.25);
  let specular = pow(max(dot(reflect(-toLight, normal), -direction), 0.0), 28.0);
  let ambient = vec3<f32>(0.16, 0.20, 0.30) * occlusion;
  // A weak fill from the camera, with no shadow and no second march: without
  // it every face turned away from the one light is flat black and the detail
  // on it is lost.
  let fill = max(dot(normal, -direction), 0.0) * 0.45;
  var colour = tint * (ambient + fill + diffuse * shade * march.light.w) * occlusion;
  colour = colour + vec3<f32>(1.0, 0.95, 0.88) * specular * shade * march.light.w * 0.6;
  // Far surfaces fade into the same sky a miss draws, so the distance cap is
  // not a hard edge across the frame.
  let fog = clamp(ray.distance / march.bounds.y, 0.0, 1.0);
  return vec4<f32>(mix(colour, sky, fog * fog) + halo * 0.2, 1.0);
}
