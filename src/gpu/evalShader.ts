/**
 * Candidate scoring kernel.
 *
 * One workgroup == one candidate affine transform. The 128 invocations of the
 * workgroup stride over the sampled source pixels, transform them into image B,
 * bilinearly fetch B, and accumulate the five sums needed for a zero-mean
 * normalised cross-correlation (NCC). Those sums are tree-reduced in shared
 * memory and the final score is written by invocation 0.
 *
 *   out[i*8 + 0] = score   (NCC with overlap penalty; < -2 means rejected)
 *   out[i*8 + 1] = ncc     (raw correlation, -1..1)
 *   out[i*8 + 2] = overlap (fraction of samples landing inside B)
 *   out[i*8 + 3] = meanA
 *   out[i*8 + 4] = meanB
 */
export const EVAL_WGSL = /* wgsl */ `
struct Uniforms {
  count: u32,
  sampleCount: u32,
  _p0: u32,
  _p1: u32,
  imgBWidth: f32,
  imgBHeight: f32,
  rB: f32,
  minValid: f32,
  overlapPenalty: f32,
  _p2: f32,
  _p3: f32,
  _p4: f32,
};

@group(0) @binding(0) var<uniform> U: Uniforms;
@group(0) @binding(1) var texB: texture_2d<f32>;
@group(0) @binding(2) var sampB: sampler;
@group(0) @binding(3) var<storage, read> candidates: array<f32>;
@group(0) @binding(4) var<storage, read> samplePos: array<vec2f>;
@group(0) @binding(5) var<storage, read> sampleLuma: array<f32>;
@group(0) @binding(6) var<storage, read_write> outv: array<f32>;

const WG: u32 = 128u;

var<workgroup> s_sa: array<f32, 128>;
var<workgroup> s_sb: array<f32, 128>;
var<workgroup> s_sab: array<f32, 128>;
var<workgroup> s_saa: array<f32, 128>;
var<workgroup> s_sbb: array<f32, 128>;
var<workgroup> s_cnt: array<f32, 128>;

@compute @workgroup_size(128)
fn main(
  @builtin(workgroup_id) wid: vec3u,
  @builtin(local_invocation_index) lid: u32,
) {
  let ci = wid.x;
  // ci is workgroup-uniform, so this branch is uniform (no barrier divergence)
  let isActive = ci < U.count;

  let b = ci * 8u;
  let m0 = candidates[b + 0u];
  let m1 = candidates[b + 1u];
  let m2 = candidates[b + 2u];
  let m3 = candidates[b + 3u];
  let tx = candidates[b + 4u];
  let ty = candidates[b + 5u];

  var sa = 0.0;
  var sb = 0.0;
  var sab = 0.0;
  var saa = 0.0;
  var sbb = 0.0;
  var cnt = 0.0;

  if (isActive) {
    let kx = U.rB / U.imgBWidth;
    let ky = U.rB / U.imgBHeight;
    for (var i = lid; i < U.sampleCount; i = i + WG) {
      let p = samplePos[i];
      let xb = m0 * p.x + m1 * p.y + tx;
      let yb = m2 * p.x + m3 * p.y + ty;
      let u = 0.5 + xb * kx;
      let v = 0.5 + yb * ky;
      if (u >= 0.0 && u <= 1.0 && v >= 0.0 && v <= 1.0) {
        let c = textureSampleLevel(texB, sampB, vec2f(u, v), 0.0);
        let lb = dot(c.rgb, vec3f(0.299, 0.587, 0.114));
        let la = sampleLuma[i];
        sa = sa + la;
        sb = sb + lb;
        sab = sab + la * lb;
        saa = saa + la * la;
        sbb = sbb + lb * lb;
        cnt = cnt + 1.0;
      }
    }
  }

  s_sa[lid] = sa;
  s_sb[lid] = sb;
  s_sab[lid] = sab;
  s_saa[lid] = saa;
  s_sbb[lid] = sbb;
  s_cnt[lid] = cnt;
  workgroupBarrier();

  var stride = WG / 2u;
  loop {
    if (stride == 0u) { break; }
    if (lid < stride) {
      s_sa[lid] = s_sa[lid] + s_sa[lid + stride];
      s_sb[lid] = s_sb[lid] + s_sb[lid + stride];
      s_sab[lid] = s_sab[lid] + s_sab[lid + stride];
      s_saa[lid] = s_saa[lid] + s_saa[lid + stride];
      s_sbb[lid] = s_sbb[lid] + s_sbb[lid + stride];
      s_cnt[lid] = s_cnt[lid] + s_cnt[lid + stride];
    }
    workgroupBarrier();
    stride = stride / 2u;
  }

  if (lid == 0u) {
    let n = s_cnt[0];
    var score = -3.0;
    var ncc = 0.0;
    var overlap = 0.0;
    var meanA = 0.0;
    var meanB = 0.0;

    if (n >= 8.0) {
      overlap = n / f32(U.sampleCount);
      meanA = s_sa[0] / n;
      meanB = s_sb[0] / n;
      let va = max(s_saa[0] - s_sa[0] * s_sa[0] / n, 0.0);
      let vb = max(s_sbb[0] - s_sb[0] * s_sb[0] / n, 0.0);
      let cov = s_sab[0] - s_sa[0] * s_sb[0] / n;
      let den = sqrt(va * vb);
      if (den > 1e-7) {
        ncc = cov / den;
      }
      score = ncc - U.overlapPenalty * (1.0 - overlap);
      if (overlap < U.minValid) {
        score = -2.0 - (U.minValid - overlap) * 4.0;
      }
    }

    let o = ci * 8u;
    outv[o + 0u] = score;
    outv[o + 1u] = ncc;
    outv[o + 2u] = overlap;
    outv[o + 3u] = meanA;
    outv[o + 4u] = meanB;
    outv[o + 5u] = 0.0;
    outv[o + 6u] = 0.0;
    outv[o + 7u] = 0.0;
  }
}
`;

export const UNIFORM_FLOATS = 12;

/**
 * Single-transform measurement kernel.
 *
 * Same sampling as the scoring kernel, but it also builds a 32x32 joint
 * intensity histogram in workgroup memory so we can report mutual information
 * (the classic multimodal registration metric) alongside NCC.
 *
 *   out[0] = MI (bits)        out[4] = ncc
 *   out[1] = normalised MI    out[5] = overlap
 *   out[2] = H(A)             out[6] = score
 *   out[3] = H(B)             out[7] = valid count
 *   histOut[32*32] = raw joint counts (row = B bin, col = A bin)
 */
export const MEASURE_WGSL = /* wgsl */ `
struct MU {
  params: vec4u, // sampleCount, bins, 0, 0
  img: vec4f,    // imgBWidth, imgBHeight, rB, minValid
  misc: vec4f,   // overlapPenalty, 0, 0, 0
  mat0: vec4f,   // m0, m1, m2, m3
  mat1: vec4f,   // tx, ty, 0, 0
};

@group(0) @binding(0) var<uniform> M: MU;
@group(0) @binding(1) var texB: texture_2d<f32>;
@group(0) @binding(2) var sampB: sampler;
@group(0) @binding(3) var<storage, read> samplePos: array<vec2f>;
@group(0) @binding(4) var<storage, read> sampleLuma: array<f32>;
@group(0) @binding(5) var<storage, read_write> outv: array<f32>;
@group(0) @binding(6) var<storage, read_write> histOut: array<f32>;

const WG: u32 = 128u;
const BINS: u32 = 32u;
const NB: u32 = BINS * BINS;

var<workgroup> hist: array<atomic<u32>, 1024>;
var<workgroup> rowAcc: array<atomic<u32>, 32>;
var<workgroup> colAcc: array<atomic<u32>, 32>;
var<workgroup> s_sa: array<f32, 128>;
var<workgroup> s_sb: array<f32, 128>;
var<workgroup> s_sab: array<f32, 128>;
var<workgroup> s_saa: array<f32, 128>;
var<workgroup> s_sbb: array<f32, 128>;
var<workgroup> s_cnt: array<f32, 128>;
var<workgroup> s_mi: array<f32, 128>;
var<workgroup> s_ha: array<f32, 128>;
var<workgroup> s_hb: array<f32, 128>;

@compute @workgroup_size(128)
fn main(@builtin(local_invocation_index) lid: u32) {
  for (var i = lid; i < NB; i = i + WG) {
    atomicStore(&hist[i], 0u);
  }
  for (var i = lid; i < BINS; i = i + WG) {
    atomicStore(&rowAcc[i], 0u);
    atomicStore(&colAcc[i], 0u);
  }
  workgroupBarrier();

  var sa = 0.0;
  var sb = 0.0;
  var sab = 0.0;
  var saa = 0.0;
  var sbb = 0.0;
  var cnt = 0.0;

  let kx = M.img.z / M.img.x;
  let ky = M.img.z / M.img.y;
  let m0 = M.mat0.x;
  let m1 = M.mat0.y;
  let m2 = M.mat0.z;
  let m3 = M.mat0.w;
  let tx = M.mat1.x;
  let ty = M.mat1.y;

  for (var i = lid; i < M.params.x; i = i + WG) {
    let p = samplePos[i];
    let xb = m0 * p.x + m1 * p.y + tx;
    let yb = m2 * p.x + m3 * p.y + ty;
    let u = 0.5 + xb * kx;
    let v = 0.5 + yb * ky;
    if (u >= 0.0 && u <= 1.0 && v >= 0.0 && v <= 1.0) {
      let c = textureSampleLevel(texB, sampB, vec2f(u, v), 0.0);
      let lb = dot(c.rgb, vec3f(0.299, 0.587, 0.114));
      let la = sampleLuma[i];
      sa = sa + la;
      sb = sb + lb;
      sab = sab + la * lb;
      saa = saa + la * la;
      sbb = sbb + lb * lb;
      cnt = cnt + 1.0;
      let ai = min(BINS - 1u, u32(max(0.0, la) * f32(BINS)));
      let bi = min(BINS - 1u, u32(max(0.0, lb) * f32(BINS)));
      atomicAdd(&hist[bi * BINS + ai], 1u);
    }
  }

  s_sa[lid] = sa;
  s_sb[lid] = sb;
  s_sab[lid] = sab;
  s_saa[lid] = saa;
  s_sbb[lid] = sbb;
  s_cnt[lid] = cnt;
  // every atomicAdd must be visible before the histogram is read back
  workgroupBarrier();

  // row / column marginals + histogram export (writes do not touch the s_ arrays)
  for (var i = lid; i < NB; i = i + WG) {
    let v = atomicLoad(&hist[i]);
    histOut[i] = f32(v);
    if (v > 0u) {
      atomicAdd(&rowAcc[i / BINS], v);
      atomicAdd(&colAcc[i % BINS], v);
    }
  }
  workgroupBarrier();

  // ---- phase 1: reduce the correlation sums so every thread knows N
  var stride = WG / 2u;
  loop {
    if (stride == 0u) { break; }
    if (lid < stride) {
      s_sa[lid] = s_sa[lid] + s_sa[lid + stride];
      s_sb[lid] = s_sb[lid] + s_sb[lid + stride];
      s_sab[lid] = s_sab[lid] + s_sab[lid + stride];
      s_saa[lid] = s_saa[lid] + s_saa[lid + stride];
      s_sbb[lid] = s_sbb[lid] + s_sbb[lid + stride];
      s_cnt[lid] = s_cnt[lid] + s_cnt[lid + stride];
    }
    workgroupBarrier();
    stride = stride / 2u;
  }

  // ---- phase 2: mutual information from the joint histogram
  let n = s_cnt[0];
  var mi = 0.0;
  var ha = 0.0;
  var hb = 0.0;
  if (n > 0.0) {
    for (var i = lid; i < NB; i = i + WG) {
      let v = atomicLoad(&hist[i]);
      if (v == 0u) {
        continue;
      }
      let pb = f32(atomicLoad(&rowAcc[i / BINS])) / n;
      let pa = f32(atomicLoad(&colAcc[i % BINS])) / n;
      let p = f32(v) / n;
      mi = mi + p * log2(p / (pa * pb));
    }
    for (var j = lid; j < BINS; j = j + WG) {
      let pb = f32(atomicLoad(&rowAcc[j])) / n;
      if (pb > 0.0) {
        hb = hb - pb * log2(pb);
      }
      let pa = f32(atomicLoad(&colAcc[j])) / n;
      if (pa > 0.0) {
        ha = ha - pa * log2(pa);
      }
    }
  }
  s_mi[lid] = mi;
  s_ha[lid] = ha;
  s_hb[lid] = hb;
  workgroupBarrier();

  // ---- phase 3: reduce the MI totals
  var stride2 = WG / 2u;
  loop {
    if (stride2 == 0u) { break; }
    if (lid < stride2) {
      s_mi[lid] = s_mi[lid] + s_mi[lid + stride2];
      s_ha[lid] = s_ha[lid] + s_ha[lid + stride2];
      s_hb[lid] = s_hb[lid] + s_hb[lid + stride2];
    }
    workgroupBarrier();
    stride2 = stride2 / 2u;
  }

  if (lid == 0u) {
    let tot = s_cnt[0];
    var ncc = 0.0;
    var overlap = 0.0;
    var score = -3.0;
    var valid = 0.0;
    if (tot >= 8.0) {
      valid = tot;
      overlap = tot / f32(M.params.x);
      let va = max(s_saa[0] - s_sa[0] * s_sa[0] / tot, 0.0);
      let vb = max(s_sbb[0] - s_sb[0] * s_sb[0] / tot, 0.0);
      let cov = s_sab[0] - s_sa[0] * s_sb[0] / tot;
      let den = sqrt(va * vb);
      if (den > 1e-7) {
        ncc = cov / den;
      }
      score = ncc - M.misc.x * (1.0 - overlap);
      if (overlap < M.img.w) {
        score = -2.0 - (M.img.w - overlap) * 4.0;
      }
    }
    let mi = s_mi[0];
    let ha = max(s_ha[0], 1e-6);
    let hb = max(s_hb[0], 1e-6);
    outv[0] = mi;
    outv[1] = (2.0 * mi) / (ha + hb);
    outv[2] = ha;
    outv[3] = hb;
    outv[4] = ncc;
    outv[5] = overlap;
    outv[6] = score;
    outv[7] = valid;
  }
}
`;
