/** compact viridis-ish ramp for the score heatmap */
const STOPS: [number, number, number][] = [
  [26, 24, 48],
  [45, 40, 92],
  [52, 76, 140],
  [38, 116, 146],
  [34, 150, 133],
  [94, 190, 101],
  [196, 220, 68],
  [253, 231, 37],
];

export function heatColor(t: number, out: Uint8ClampedArray, o: number): void {
  const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
  const f = x * (STOPS.length - 1);
  const i0 = Math.min(STOPS.length - 1, Math.floor(f));
  const i1 = Math.min(STOPS.length - 1, i0 + 1);
  const k = f - i0;
  out[o] = STOPS[i0][0] + (STOPS[i1][0] - STOPS[i0][0]) * k;
  out[o + 1] = STOPS[i0][1] + (STOPS[i1][1] - STOPS[i0][1]) * k;
  out[o + 2] = STOPS[i0][2] + (STOPS[i1][2] - STOPS[i0][2]) * k;
  out[o + 3] = 255;
}

export function heatCss(t: number): string {
  const buf = new Uint8ClampedArray(4);
  heatColor(t, buf, 0);
  return `rgb(${buf[0]},${buf[1]},${buf[2]})`;
}

export const EMPTY_CELL = 'rgba(28,31,38,1)';
