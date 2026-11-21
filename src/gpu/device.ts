export interface GPUEnv {
  adapter: GPUAdapter;
  device: GPUDevice;
  format: GPUTextureFormat;
  info: string;
}

export async function initGPU(): Promise<GPUEnv> {
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    throw new Error(
      'WebGPU is not available in this browser. Use Chrome/Edge 113+, or Firefox/Safari with WebGPU enabled.',
    );
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No suitable GPU adapter found (requestAdapter returned null).');

  const device = await adapter.requestDevice({
    requiredLimits: {
      maxStorageBufferBindingSize: Math.min(
        adapter.limits.maxStorageBufferBindingSize,
        1 << 28, // 256 MiB
      ),
    },
  });

  device.addEventListener('uncapturederror', (ev) => {
    // eslint-disable-next-line no-console
    console.error('[webgpu]', (ev as GPUUncapturedErrorEvent).error.message);
  });

  const anyAdapter = adapter as unknown as { info?: GPUAdapterInfo };
  const info = anyAdapter.info
    ? [anyAdapter.info.vendor, anyAdapter.info.architecture, anyAdapter.info.description]
        .filter(Boolean)
        .join(' · ') || 'WebGPU device'
    : 'WebGPU device';

  return { adapter, device, format: navigator.gpu.getPreferredCanvasFormat(), info };
}

/** upload an Img into a sampleable rgba8unorm texture */
export function uploadTexture(device: GPUDevice, img: { width: number; height: number; data: ImageData }, label: string): GPUTexture {
  const w = img.width;
  const h = img.height;
  const tex = device.createTexture({
    label,
    size: { width: w, height: h },
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const src = img.data.data;
  const bytesPerRow = Math.ceil((w * 4) / 256) * 256;
  const padded = new Uint8Array(bytesPerRow * h);
  for (let y = 0; y < h; y++) {
    const from = y * w * 4;
    padded.set(src.subarray(from, from + w * 4), y * bytesPerRow);
  }
  device.queue.writeTexture({ texture: tex }, padded, { bytesPerRow, rowsPerImage: h }, { width: w, height: h });
  return tex;
}
