# mi-align

Affine image alignment in the browser. Load two images (any size, any aspect ratio), and a WebGPU
compute kernel scores tens of thousands of candidate transforms in one pass. The result is not just
the best transform but a map of the whole similarity landscape: global optimum, competing local
optima, and the ridges in between.

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + production build
npm test           # browser test suites (headless Chrome + SwiftShader WebGPU)
```

Requires a WebGPU-capable browser (Chrome/Edge 113+). The app degrades to a clear error message if
WebGPU cannot start.

## What it does

**Landing page** — start a new project (drop your own two images) or open one of five generated
examples. Every example ships with an exact ground truth transform, so the error is shown live.

**Exhaustive search** — the search space is the affine group with a per-axis grid:

| axis     | meaning                                     |
| -------- | ------------------------------------------- |
| `tx,ty`  | translation in normalised image units       |
| `θ`      | rotation                                    |
| `s`      | uniform scale                               |
| `a`      | aspect (sx/sy)                              |
| `sh`     | shear                                       |

The number of candidates is the product of the enabled axes' step counts. Each candidate is scored
against image B with a zero-mean NCC over a fixed set of sampled source pixels, minus an overlap
penalty. One workgroup per candidate, 128 invocations striding over the samples, tree-reduced in
shared memory. Batches of 8192 candidates stream through the GPU with a progress bar.

**Stochastic multi-start** — optionally, draw `N` random candidates, keep the `K` best that are far
apart, then run a batched compass search from every seed (all seeds probe all axes in a single
dispatch). Trajectories are drawn on the heatmap.

**Sampling** — the cost is `candidates × samples`. Sampling can be a stratified jittered grid, uniform
random, or gradient-weighted (edges only). Turning sampling off uses every pixel (capped).

**The N-D heatmap** — the hard part: a 6-dimensional landscape cannot be drawn at once. The map shows
two axes of your choice and, for every cell, the **maximum over all remaining axes** (a max-projection
of the landscape). Isolated peaks are therefore genuine local optima of the full space. Hovering a
cell resolves the hidden axes' values and previews that exact transform in the overlay. `slice at best`
shows the true 2-D cross-section instead.

**Exploration** — click a cell to select it, then *dive inside*: the whole search space is narrowed to
that cell, the grid is re-searched, and the breadcrumb records the path. Diving re-ranges **every**
enabled axis relative to the picked position — the two mapped axes take the cell's interval, the
hidden axes take the interval of the candidate that produced the cell's score, and the header chips
always show the exact ranges in force. Locked axes are untouched. Diving into a black (unexplored)
cell works too: only the mapped axes are narrowed, leaving the hidden ones wide open.

The heatmap zooms with the wheel (0.3×–48×) and pans with the pointer, following it in both axes.
Zooming is also how you descend the hierarchy: once the viewport only spans a handful of cells, the
region under the cursor is re-searched automatically on a grid of the same resolution but over the
cell-sized interval (so steps get ~19× finer per dive), and the camera re-frames the sub-grid.
Zooming back out below the level's cell size climbs to the parent with the framing kept continuous,
so the neighbouring cells reappear where you left them. `auto-refine with zoom` toggles the whole
behaviour; the explicit `dive inside this cell →` / `← up` controls do the same thing by hand.
Explored cells get a dashed border, never-scanned cells are drawn black.

**Locking** — any axis can be locked at a concrete value (⎘ copies the current value) and excluded
from the search, which is how you slice through the space and hunt for optima around a fixed rotation
or scale.

**Manual editing** — drag the moving image to translate, `shift`+drag sideways to rotate, `ctrl`+drag
radially to scale, `ctrl`+wheel to zoom out. Everything downstream (score, mutual information, joint
histogram) updates live, so you can feel how sharp the optimum is.

**Mutual information** — a separate single-transform kernel builds a 32×32 joint intensity histogram
in workgroup memory and reports MI in bits, normalised MI, both entropies, NCC and overlap. MI is
insensitive to monotonic brightness changes, so it is the honest multimodal readout; the joint
histogram is drawn next to it and tightens into a diagonal as the images line up.

**Overlay modes** — blend, absolute difference, checkerboard, A only, B only.

## Layout

```
src/
  lib/
    config.ts       search-space model (DOFs, grids, locking, cell ranges)
    affine.ts       6-DOF parameterisation <-> matrix, inverse, error metrics
    search.ts       exhaustive grid, stochastic multi-start, compass search
    heatmap.ts      max-projection / slice, argmax retention, local-maxima detection
    sampling.ts     source-pixel sampling strategies
    examples.ts     procedural scenes, two-viewpoint rendering, exact ground truth
    image.ts        file loading + canvas plumbing
  gpu/
    evalShader.ts   WGSL: per-candidate scorer + single-transform MI measurement
    aligner.ts      pipelines, buffers, chunked streams, readback
    warp.ts         render pipeline for the warped overlay
  components/       landing, panels, heatmap canvas, warp canvas, MI panel
  App.tsx           state machine: frames (dive stack), runs, manual edits
test/smoke.ts       end-to-end GPU test page (real kernels, real images)
scripts/            headless-Chrome drivers for the test suites
```

### Transform convention

Both images are mapped into a canonical frame: `X = (px + 0.5 − W/2) / R` with `R = max(W, H) / 2`.
Canonical coordinates therefore always span ±1 on the longer side, and the transform

```
X_b = M · X_a + t,      M = R(θ) · Shear(sh) · Scale(sx, sy)
```

is resolution- and aspect-independent. That is what lets a 640×480 detail be aligned to a 420×560
overview — the truth for that pair is `scale 0.64`, `θ 3°`, `t = (−0.068, 0.041)`.

Examples are generated by painting one large scene and "photographing" it from two viewpoints
(different windows, zooms, sensor rotation, anisotropic stretch and shear). The ground truth is
derived analytically from the two view matrices, then verified in the test suite by evaluating it.

## Tests

`npm test` starts a dev server and drives headless Chrome (with SwiftShader when no GPU is present):

- `test/smoke.ts` — GPU pipeline end to end: scores the true transform vs decoys, runs a full grid +
  refinement (recovers the truth to ~0.06% of the image radius), checks the heatmap projection,
  optima detection, slice mode, stochastic search, MI (higher at the truth, histogram sums to the
  sample count, entropy bounds), the renderer pixels, and evaluates the ground truth of every example.
- `scripts/ui-check.mjs` — landing page, opening the differing-size example, the suggested search
  space, live MI, drag/rotate/scale/zoom interactions, heatmap zoom/pan/select/dive/back,
  axis locking, and session resume.
- `scripts/visual-check.mjs` — captures screenshots and asserts on region statistics: the overlay
  shows content, the heatmap has peaks and black unexplored cells, the joint histogram is drawn.
