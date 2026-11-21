export interface Img {
  id: string;
  name: string;
  width: number;
  height: number;
  canvas: HTMLCanvasElement;
  data: ImageData;
}

export const MAX_SIDE = 1024;

export function canvasFromImageData(data: ImageData): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = data.width;
  c.height = data.height;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.putImageData(data, 0, 0);
  return c;
}

export function imgFromCanvas(canvas: HTMLCanvasElement, name: string, id: string = crypto.randomUUID()): Img {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { id, name, width: canvas.width, height: canvas.height, canvas, data };
}

function fitCanvas(w: number, h: number): HTMLCanvasElement {
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * scale));
  c.height = Math.max(1, Math.round(h * scale));
  return c;
}

export async function loadImageFile(file: File): Promise<Img> {
  const bmp = await createImageBitmap(file);
  try {
    const canvas = fitCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return imgFromCanvas(canvas, file.name);
  } finally {
    bmp.close();
  }
}

/** simple thumbnail as a data URL, used for the picker */
export function thumbnail(img: Img, max = 220): string {
  const scale = Math.min(max / img.width, max / img.height, 1);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.width * scale));
  c.height = Math.max(1, Math.round(img.height * scale));
  const ctx = c.getContext('2d')!;
  ctx.drawImage(img.canvas, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}
