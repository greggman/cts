import { assert } from '../common/util/util.js';

export type FlatSampling = 'first' | 'last';

const s_deviceToEitherSamplingIndex = new WeakMap<GPUDevice, FlatSampling>();

/**
 * Returns whether the device uses the first first or last vertex for the
 * provoking vertex when using @interpolate(flat, either)
 */
export async function getProvokingVertexForFlatInterpolationEitherSampling(
  device: GPUDevice
): Promise<FlatSampling> {
  let sampling = s_deviceToEitherSamplingIndex.get(device);
  if (!sampling) {
    const module = device.createShaderModule({
      code: `
        struct VSOut {
          @builtin(position) position: vec4f,
          @location(0) @interpolate(flat, either) vertexIndex: u32,
        };

        @vertex fn vs(
          @builtin(vertex_index) vertexIndex : u32,
        ) -> VSOut {
          let pos = array(vec2f(-1, 3), vec2f(3, -1), vec2f(-1, 1));
          var vsOutput: VSOut;
          vsOutput.position = vec4f(pos[vertexIndex], 0, 1);
          vsOutput.vertexIndex = vertexIndex;
          return vsOutput;
        }

        @fragment fn fs(@location(0) @interpolate(flat, either) vertexIndex: u32) -> @location(0) vec4f {
          return vec4f(f32(vertexIndex) / 255.0);
        }
      `,
    });

    const pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module,
      },
      fragment: {
        module,
        targets: [{ format: 'rgba8unorm' }],
      },
    });

    const texture = device.createTexture({
      format: 'rgba8unorm',
      size: [1, 1],
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: texture.createView(),
          clearValue: [1, 1, 1, 1],
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.draw(3);
    pass.end();

    const buffer = device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    encoder.copyTextureToBuffer({ texture }, { buffer }, [1, 1]);

    const commandBuffer = encoder.finish();
    device.queue.submit([commandBuffer]);

    await buffer.mapAsync(GPUMapMode.READ);
    const result = new Uint8Array(buffer.getMappedRange())[0];
    buffer.unmap();
    buffer.destroy();
    texture.destroy();

    assert(result === 0 || result === 2);
    sampling = result === 2 ? 'last' : 'first';
    s_deviceToEitherSamplingIndex.set(device, sampling);
  }
  return sampling;
}
