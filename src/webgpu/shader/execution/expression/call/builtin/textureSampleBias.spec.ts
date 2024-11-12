export const description = `
Execution tests for the 'textureSampleBias' builtin function

Samples a texture with a bias to the mip level.

- TODO: test cube maps with more than one mip level.
- TODO: Test un-encodable formats.
`;

import { makeTestGroup } from '../../../../../../common/framework/test_group.js';
import { isFilterableAsTextureF32, kAllTextureFormats } from '../../../../../format_info.js';
import { TextureTestMixin } from '../../../../../gpu_test.js';
import { clamp } from '../../../../../util/math.js';

import {
  vec2,
  vec3,
  TextureCall,
  generateTextureBuiltinInputs2D,
  generateTextureBuiltinInputs3D,
  kSamplePointMethods,
  kShortAddressModes,
  kShortAddressModeToAddressMode,
  doTextureCalls,
  checkCallResults,
  createTextureWithRandomDataAndGetTexels,
  generateSamplePointsCube,
  kCubeSamplePointMethods,
  SamplePointMethods,
  chooseTextureSize,
  isPotentiallyFilterableAndFillable,
  skipIfTextureFormatNotSupportedNotAvailableOrNotFilterable,
  getTextureTypeForTextureViewDimension,
  WGSLTextureSampleTest,
  isSupportedViewFormatCombo,
  skipIfNeedsFilteringAndIsUnfilterable,
} from './texture_utils.js';

export const g = makeTestGroup(TextureTestMixin(WGSLTextureSampleTest));

function makeGraph(width: number, height: number) {
  const data = new Uint8Array(width * height);

  return {
    plot(norm: number, x: number, c: number) {
      const y = clamp(Math.floor(norm * height), { min: 0, max: height - 1 });
      const offset = (height - y - 1) * width + x;
      data[offset] = c;
    },
    plotValues(values: Iterable<number>, c: number) {
      let i = 0;
      for (const v of values) {
        this.plot(v, i, c);
        ++i;
      }
    },
    toString(conversion = ['.', 'e', 'A']) {
      const lines = [];
      for (let y = 0; y < height; ++y) {
        const offset = y * width;
        lines.push([...data.subarray(offset, offset + width)].map(v => conversion[v]).join(''));
      }
      return lines.join('\n');
    },
  };
}

function safeStr(v?: string | number) {
  return v === undefined ? 'undefined' : v.toString();
}

function pad(format: string, len: number, v: string | number) {
  switch (format) {
    case '>': // move to right
    case 'r': // pad right
    case 's': // pad start
      return safeStr(v).padStart(len);
    default:
      return safeStr(v).padEnd(len);
  }
}

function padColumns(rows: (string | number)[][], formats = '') {
  const columnLengths: number[] = [];

  // get size of each column
  for (const row of rows) {
    row.forEach((v, i) => {
      columnLengths[i] = Math.max(columnLengths[i] || 0, safeStr(v).length);
    });
  }

  return rows
    .map(row => row.map((v, i) => pad(formats[i], columnLengths[i], v)).join(''))
    .join('\n');
}

g.test('info')
  .desc(
    `
    test various bias settings for a given mip level with different texture sizes
`
  )
  .fn(async t => {
    const { device } = t;
    const biases = [
      -16, -15.9, -15.8, -15, 8, 9, 10, 11, 12, 12.125, 12.25, 12.5, 12.75, 13, 14, 15, 15.99,
    ];

    const module = device.createShaderModule({
      code: `
struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) @interpolate(flat, either) ndx: u32,
  @location(1) @interpolate(flat, either) result: vec4<f32>,
};

struct Data {
  derivativeMult: f32,
  bias: f32,
  pad0: f32,
  pad1: f32,
};

@group(0) @binding(0) var          T    : texture_2d<f32>;
@group(0) @binding(1) var          S    : sampler;
@group(0) @binding(2) var<uniform> data : array<Data, ${biases.length}>;

fn getResult(idx: u32, derivativeBase: vec2f) -> vec4<f32> {
  let args = data[idx];
  return textureSampleBias(T, S, vec2f(0.5) + derivativeBase * vec2f(args.derivativeMult, 0), args.bias);
}

// --------------------------- fragment stage shaders --------------------------------
@vertex fn vsFragment(
    @builtin(vertex_index) vertex_index : u32,
    @builtin(instance_index) instance_index : u32) -> VOut {
  let positions = array(vec2f(-1, 3), vec2f(3, -1), vec2f(-1, -1));
  return VOut(vec4f(positions[vertex_index], 0, 1), instance_index, vec4<f32>(0));
}

@fragment fn fsFragment(v: VOut) -> @location(0) vec4u {
  let derivativeBase = (v.pos.xy - 0.5 - vec2f(f32(v.ndx), 0)) / vec2f(textureDimensions(T));
  return bitcast<vec4u>(getResult(v.ndx, derivativeBase));
  //return bitcast<vec4u>(vec4f(data[v.ndx].bias));
}
      `,
    });

    const pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module },
      fragment: { module, targets: [{ format: 'rgba32uint' }] },
    });

    const sampler = device.createSampler({
      minFilter: 'linear',
      magFilter: 'linear',
      mipmapFilter: 'linear',
    });

    const data = new Float32Array(biases.length * 4);
    biases.forEach((bias, i) => {
      const mipLevel = 0.5;
      const derivativeBasedMipLevel = mipLevel - bias;
      const derivativeMult = Math.pow(2, derivativeBasedMipLevel);
      const offset = i * 4;
      data[offset + 0] = derivativeMult;
      data[offset + 1] = bias;
    });

    const dataBuffer = t.createBufferTracked({
      size: data.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(dataBuffer, 0, data);

    const sizes = [2, 4, 8, 12, 16, 24, 32, 40, 128];
    const buffers: GPUBuffer[] = [];
    await Promise.all(
      sizes.map(size => {
        const texture = t.createTextureTracked({
          size: [size, size],
          format: 'r8unorm',
          usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
          mipLevelCount: 2,
        });

        // fill mip level 1 with ones
        const ones = new Uint8Array((texture.width / 2) * (texture.height / 2)).fill(255);
        device.queue.writeTexture({ texture, mipLevel: 1 }, ones, { bytesPerRow: size / 2 }, [
          size / 2,
          size / 2,
        ]);

        const bindGroup = device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: texture.createView() },
            { binding: 1, resource: sampler },
            { binding: 2, resource: { buffer: dataBuffer } },
          ],
        });

        const resultTexture = t.createTextureTracked({
          size: [biases.length, 1],
          format: 'rgba32uint',
          usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
        });

        const resultBuffer = t.createBufferTracked({
          size: resultTexture.width * 4 * 4,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });

        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: resultTexture.createView(),
              loadOp: 'clear',
              storeOp: 'store',
            },
          ],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        for (let i = 0; i < biases.length; ++i) {
          pass.setViewport(i, 0, 1, 1, 0, 1);
          pass.draw(3, 1, 0, i);
        }
        pass.end();
        encoder.copyTextureToBuffer(
          { texture: resultTexture },
          {
            buffer: resultBuffer,
          },
          [biases.length, 1]
        );
        device.queue.submit([encoder.finish()]);
        buffers.push(resultBuffer);
        return resultBuffer.mapAsync(GPUMapMode.READ);
      })
    );

    const graph = makeGraph(biases.length, 20);

    const rows: (number | string)[][] = [['bias->', ...biases.map(v => `|${v}`)]];
    rows.push(rows[0].map(v => '|-------'));
    sizes.forEach((size, i) => {
      const results = new Float32Array(buffers[i].getMappedRange());
      const row: (number | string)[] = [`size:${size}`];
      for (let j = 0; j < results.length; j += 4) {
        graph.plot((1 - results[j] - 0.4) / 0.2, j / 4, i + 1);
        row.push(`|${(1 - results[j]).toFixed(5)}`);
      }
      rows.push(row);
    });

    t.info(`\n${padColumns(rows)}`);
    t.info(`\n${graph.toString(['.', ...biases.map((v, i) => String.fromCodePoint(97 + i))])}`);
    t.expectOK(new Error('info'));
  });

g.test('sampled_2d_coords')
  .specURL('https://www.w3.org/TR/WGSL/#texturesamplebias')
  .desc(
    `
fn textureSampleBias(t: texture_2d<f32>, s: sampler, coords: vec2<f32>, bias: f32) -> vec4<f32>
fn textureSampleBias(t: texture_2d<f32>, s: sampler, coords: vec2<f32>, bias: f32, offset: vec2<i32>) -> vec4<f32>

Parameters:
 * t: The sampled texture to read from
 * s: The sampler type
 * coords: The texture coordinates
 * bias: The bias to apply to the mip level before sampling. bias must be between -16.0 and 15.99.
 * offset:
    - The optional texel offset applied to the unnormalized texture coordinate before sampling the texture.
      This offset is applied before applying any texture wrapping modes.
    - The offset expression must be a creation-time expression (e.g. vec2<i32>(1, 2)).
    - Each offset component must be at least -8 and at most 7.
      Values outside of this range will result in a shader-creation error.
`
  )
  .params(u =>
    u
      .combine('format', kAllTextureFormats)
      .filter(t => isPotentiallyFilterableAndFillable(t.format))
      .combine('filt', ['nearest', 'linear'] as const)
      .filter(t => t.filt === 'nearest' || isFilterableAsTextureF32(t.format))
      .combine('modeU', kShortAddressModes)
      .combine('modeV', kShortAddressModes)
      .combine('offset', [false, true] as const)
      .beginSubcases()
      .combine('samplePoints', kSamplePointMethods)
  )
  .beforeAllSubcases(t =>
    skipIfTextureFormatNotSupportedNotAvailableOrNotFilterable(t, t.params.format)
  )
  .fn(async t => {
    const { format, samplePoints, modeU, modeV, filt: minFilter, offset } = t.params;
    skipIfNeedsFilteringAndIsUnfilterable(t, minFilter, format);

    // We want at least 4 blocks or something wide enough for 3 mip levels.
    const [width, height] = chooseTextureSize({ minSize: 8, minBlocks: 4, format });

    const descriptor: GPUTextureDescriptor = {
      format,
      size: { width, height },
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
      mipLevelCount: 3,
    };
    const { texels, texture } = await createTextureWithRandomDataAndGetTexels(t, descriptor);
    const sampler: GPUSamplerDescriptor = {
      addressModeU: kShortAddressModeToAddressMode[modeU],
      addressModeV: kShortAddressModeToAddressMode[modeV],
      minFilter,
      magFilter: minFilter,
      mipmapFilter: minFilter,
    };

    const calls: TextureCall<vec2>[] = generateTextureBuiltinInputs2D(50, {
      sampler,
      method: samplePoints,
      descriptor,
      bias: true,
      offset,
      hashInputs: [format, samplePoints, modeU, modeV, minFilter, offset],
    }).map(({ coords, derivativeMult, offset, bias }) => {
      return {
        builtin: 'textureSampleBias',
        coordType: 'f',
        coords,
        derivativeMult,
        bias,
        offset,
      };
    });

    const viewDescriptor = {};
    const textureType = 'texture_2d<f32>';
    const results = await doTextureCalls(
      t,
      texture,
      viewDescriptor,
      textureType,
      sampler,
      calls,
      'f'
    );
    const res = await checkCallResults(
      t,
      { texels, descriptor, viewDescriptor },
      textureType,
      sampler,
      calls,
      results,
      'f',
      texture
    );
    t.expectOK(res);
  });

g.test('sampled_3d_coords')
  .specURL('https://www.w3.org/TR/WGSL/#texturesamplebias')
  .desc(
    `
fn textureSampleBias(t: texture_3d<f32>, s: sampler, coords: vec3<f32>, bias: f32) -> vec4<f32>
fn textureSampleBias(t: texture_3d<f32>, s: sampler, coords: vec3<f32>, bias: f32, offset: vec3<i32>) -> vec4<f32>
fn textureSampleBias(t: texture_cube<f32>, s: sampler, coords: vec3<f32>, bias: f32) -> vec4<f32>

Parameters:
 * t: The sampled texture to read from
 * s: The sampler type
 * coords: The texture coordinates
 * bias: The bias to apply to the mip level before sampling. bias must be between -16.0 and 15.99.
 * offset:
    - The optional texel offset applied to the unnormalized texture coordinate before sampling the texture.
      This offset is applied before applying any texture wrapping modes.
    - The offset expression must be a creation-time expression (e.g. vec2<i32>(1, 2)).
    - Each offset component must be at least -8 and at most 7.
      Values outside of this range will result in a shader-creation error.
`
  )
  .params(u =>
    u
      .combine('format', kAllTextureFormats)
      .filter(t => isPotentiallyFilterableAndFillable(t.format))
      .combine('dim', ['3d', 'cube'] as const)
      .filter(t => isSupportedViewFormatCombo(t.format, t.dim))
      .combine('filt', ['nearest', 'linear'] as const)
      .filter(t => t.filt === 'nearest' || isFilterableAsTextureF32(t.format))
      .combine('modeU', kShortAddressModes)
      .combine('modeV', kShortAddressModes)
      .combine('modeW', kShortAddressModes)
      .combine('offset', [false, true] as const)
      .filter(t => t.dim !== 'cube' || t.offset !== true)
      .beginSubcases()
      .combine('samplePoints', kCubeSamplePointMethods)
      .filter(t => t.samplePoints !== 'cube-edges' || t.dim !== '3d')
  )
  .beforeAllSubcases(t =>
    skipIfTextureFormatNotSupportedNotAvailableOrNotFilterable(t, t.params.format)
  )
  .fn(async t => {
    const {
      format,
      dim: viewDimension,
      samplePoints,
      modeU,
      modeV,
      modeW,
      filt: minFilter,
      offset,
    } = t.params;
    skipIfNeedsFilteringAndIsUnfilterable(t, minFilter, format);

    const size = chooseTextureSize({ minSize: 8, minBlocks: 2, format, viewDimension });
    const descriptor: GPUTextureDescriptor = {
      format,
      dimension: viewDimension === '3d' ? '3d' : '2d',
      ...(t.isCompatibility && { textureBindingViewDimension: viewDimension }),
      size,
      // MAINTENANCE_TODO: use 3 for cube maps when derivatives are supported for cube maps.
      mipLevelCount: viewDimension === '3d' ? 3 : 1,
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
    };
    const { texels, texture } = await createTextureWithRandomDataAndGetTexels(t, descriptor);
    const sampler: GPUSamplerDescriptor = {
      addressModeU: kShortAddressModeToAddressMode[modeU],
      addressModeV: kShortAddressModeToAddressMode[modeV],
      addressModeW: kShortAddressModeToAddressMode[modeW],
      minFilter,
      magFilter: minFilter,
    };

    const hashInputs = [
      format,
      viewDimension,
      samplePoints,
      modeU,
      modeV,
      modeW,
      minFilter,
      offset,
    ];
    const calls: TextureCall<vec3>[] = (
      viewDimension === '3d'
        ? generateTextureBuiltinInputs3D(50, {
            method: samplePoints as SamplePointMethods,
            sampler,
            descriptor,
            bias: true,
            offset,
            hashInputs,
          })
        : generateSamplePointsCube(50, {
            method: samplePoints,
            sampler,
            descriptor,
            bias: true,
            hashInputs,
          })
    ).map(({ coords, derivativeMult, offset, bias }) => {
      return {
        builtin: 'textureSampleBias',
        coordType: 'f',
        coords,
        derivativeMult,
        bias,
        offset,
      };
    });
    const viewDescriptor = {
      dimension: viewDimension,
    };
    const textureType = getTextureTypeForTextureViewDimension(viewDimension);
    const results = await doTextureCalls(
      t,
      texture,
      viewDescriptor,
      textureType,
      sampler,
      calls,
      'f'
    );
    const res = await checkCallResults(
      t,
      { texels, descriptor, viewDescriptor },
      textureType,
      sampler,
      calls,
      results,
      'f',
      texture
    );
    t.expectOK(res);
  });

g.test('arrayed_2d_coords')
  .specURL('https://www.w3.org/TR/WGSL/#texturesamplebias')
  .desc(
    `
A: i32, u32

fn textureSampleBias(t: texture_2d_array<f32>, s: sampler, coords: vec2<f32>, array_index: A, bias: f32) -> vec4<f32>
fn textureSampleBias(t: texture_2d_array<f32>, s: sampler, coords: vec2<f32>, array_index: A, bias: f32, offset: vec2<i32>) -> vec4<f32>

Parameters:
 * t: The sampled texture to read from
 * s: The sampler type
 * coords: The texture coordinates
 * array_index: The 0-based texture array index to sample.
 * bias: The bias to apply to the mip level before sampling. bias must be between -16.0 and 15.99.
 * offset:
    - The optional texel offset applied to the unnormalized texture coordinate before sampling the texture.
      This offset is applied before applying any texture wrapping modes.
    - The offset expression must be a creation-time expression (e.g. vec2<i32>(1, 2)).
    - Each offset component must be at least -8 and at most 7.
      Values outside of this range will result in a shader-creation error.
`
  )
  .params(u =>
    u
      .combine('format', kAllTextureFormats)
      .filter(t => isPotentiallyFilterableAndFillable(t.format))
      .combine('filt', ['nearest', 'linear'] as const)
      .filter(t => t.filt === 'nearest' || isFilterableAsTextureF32(t.format))
      .combine('modeU', kShortAddressModes)
      .combine('modeV', kShortAddressModes)
      .combine('offset', [false, true] as const)
      .beginSubcases()
      .combine('samplePoints', kSamplePointMethods)
      .combine('A', ['i32', 'u32'] as const)
  )
  .beforeAllSubcases(t =>
    skipIfTextureFormatNotSupportedNotAvailableOrNotFilterable(t, t.params.format)
  )
  .fn(async t => {
    const { format, samplePoints, A, modeU, modeV, filt: minFilter, offset } = t.params;
    skipIfNeedsFilteringAndIsUnfilterable(t, minFilter, format);

    // We want at least 4 blocks or something wide enough for 3 mip levels.
    const [width, height] = chooseTextureSize({ minSize: 8, minBlocks: 4, format });
    const depthOrArrayLayers = 4;

    const descriptor: GPUTextureDescriptor = {
      format,
      size: { width, height, depthOrArrayLayers },
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
      mipLevelCount: 3,
    };
    const { texels, texture } = await createTextureWithRandomDataAndGetTexels(t, descriptor);
    const sampler: GPUSamplerDescriptor = {
      addressModeU: kShortAddressModeToAddressMode[modeU],
      addressModeV: kShortAddressModeToAddressMode[modeV],
      minFilter,
      magFilter: minFilter,
      mipmapFilter: minFilter,
    };

    const calls: TextureCall<vec2>[] = generateTextureBuiltinInputs2D(50, {
      method: samplePoints,
      sampler,
      descriptor,
      arrayIndex: { num: texture.depthOrArrayLayers, type: A },
      bias: true,
      offset,
      hashInputs: [format, samplePoints, A, modeU, modeV, minFilter, offset],
    }).map(({ coords, derivativeMult, arrayIndex, bias, offset }) => {
      return {
        builtin: 'textureSampleBias',
        coordType: 'f',
        coords,
        derivativeMult,
        arrayIndex,
        arrayIndexType: A === 'i32' ? 'i' : 'u',
        bias,
        offset,
      };
    });
    const textureType = 'texture_2d_array<f32>';
    const viewDescriptor = {};
    const results = await doTextureCalls(
      t,
      texture,
      viewDescriptor,
      textureType,
      sampler,
      calls,
      'f'
    );
    const res = await checkCallResults(
      t,
      { texels, descriptor, viewDescriptor },
      textureType,
      sampler,
      calls,
      results,
      'f',
      texture
    );
    t.expectOK(res);
  });

g.test('arrayed_3d_coords')
  .specURL('https://www.w3.org/TR/WGSL/#texturesamplebias')
  .desc(
    `
A: i32, u32

fn textureSampleBias(t: texture_cube_array<f32>, s: sampler, coords: vec3<f32>, array_index: A, bias: f32) -> vec4<f32>

Parameters:
 * t: The sampled texture to read from
 * s: The sampler type
 * coords: The texture coordinates
 * array_index: The 0-based texture array index to sample.
 * bias: The bias to apply to the mip level before sampling. bias must be between -16.0 and 15.99.
 * offset:
    - The optional texel offset applied to the unnormalized texture coordinate before sampling the texture.
      This offset is applied before applying any texture wrapping modes.
    - The offset expression must be a creation-time expression (e.g. vec2<i32>(1, 2)).
    - Each offset component must be at least -8 and at most 7.
      Values outside of this range will result in a shader-creation error.
`
  )
  .params(u =>
    u
      .combine('format', kAllTextureFormats)
      .filter(t => isPotentiallyFilterableAndFillable(t.format))
      .combine('filt', ['nearest', 'linear'] as const)
      .filter(t => t.filt === 'nearest' || isFilterableAsTextureF32(t.format))
      .combine('mode', kShortAddressModes)
      .beginSubcases()
      .combine('samplePoints', kCubeSamplePointMethods)
      .combine('A', ['i32', 'u32'] as const)
  )
  .beforeAllSubcases(t => {
    skipIfTextureFormatNotSupportedNotAvailableOrNotFilterable(t, t.params.format);
    t.skipIfTextureViewDimensionNotSupported('cube-array');
  })
  .fn(async t => {
    const { format, samplePoints, A, mode, filt: minFilter } = t.params;
    skipIfNeedsFilteringAndIsUnfilterable(t, minFilter, format);

    const viewDimension: GPUTextureViewDimension = 'cube-array';
    const size = chooseTextureSize({
      minSize: 32,
      minBlocks: 4,
      format,
      viewDimension,
    });
    const descriptor: GPUTextureDescriptor = {
      format,
      size,
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
      // MAINTENANCE_TODO: use 3 for cube maps when derivatives are supported for cube maps.
      mipLevelCount: 1,
    };
    const { texels, texture } = await createTextureWithRandomDataAndGetTexels(t, descriptor);
    const sampler: GPUSamplerDescriptor = {
      addressModeU: kShortAddressModeToAddressMode[mode],
      addressModeV: kShortAddressModeToAddressMode[mode],
      addressModeW: kShortAddressModeToAddressMode[mode],
      minFilter,
      magFilter: minFilter,
      mipmapFilter: minFilter,
    };

    const calls: TextureCall<vec3>[] = generateSamplePointsCube(50, {
      method: samplePoints,
      sampler,
      descriptor,
      bias: true,
      arrayIndex: { num: texture.depthOrArrayLayers / 6, type: A },
      hashInputs: [format, viewDimension, A, samplePoints, mode, minFilter],
    }).map(({ coords, derivativeMult, arrayIndex, bias }) => {
      return {
        builtin: 'textureSampleBias',
        coordType: 'f',
        coords,
        derivativeMult,
        arrayIndex,
        arrayIndexType: A === 'i32' ? 'i' : 'u',
        bias,
      };
    });
    const viewDescriptor = {
      dimension: viewDimension,
    };
    const textureType = getTextureTypeForTextureViewDimension(viewDimension);
    const results = await doTextureCalls(
      t,
      texture,
      viewDescriptor,
      textureType,
      sampler,
      calls,
      'f'
    );
    const res = await checkCallResults(
      t,
      { texels, descriptor, viewDescriptor },
      textureType,
      sampler,
      calls,
      results,
      'f',
      texture
    );
    t.expectOK(res);
  });
