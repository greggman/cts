export const description = `
Execution tests for the 'smoothstep' builtin function

S is abstract-float, f32, f16
T is S or vecN<S>
@const fn smoothstep(low: T , high: T , x: T ) -> T
Returns the smooth Hermite interpolation between 0 and 1.
Component-wise when T is a vector.
For scalar T, the result is t * t * (3.0 - 2.0 * t), where t = clamp((x - low) / (high - low), 0.0, 1.0).

If low >= high:
* It is a shader-creation error if low and high are const-expressions.
* It is a pipeline-creation error if low and high are override-expressions.
`;

import { makeTestGroup } from '../../../../../../common/framework/test_group.js';
import { GPUTest } from '../../../../../gpu_test.js';
import { ScalarValue, Type, Value } from '../../../../../util/conversion.js';
import { clamp } from '../../../../../util/math.js';
import { Case } from '../../case.js';
import { allInputSources, onlyConstInputSource, run } from '../../expression.js';

import { abstractFloatBuiltin, builtin } from './builtin.js';
import { d } from './smoothstep.cache.js';

export const g = makeTestGroup(GPUTest);

// Returns true if `c` is valid for a const evaluation of smoothstep.
function validForConst(c: Case): boolean {
  const low = (c.input as Value[])[0] as ScalarValue;
  const high = (c.input as Value[])[1] as ScalarValue;
  return low.value < high.value;
}

g.test('abstract_float')
  .specURL('https://www.w3.org/TR/WGSL/#float-builtin-functions')
  .desc(`abstract float tests`)
  .params(u =>
    u
      .combine('inputSource', onlyConstInputSource)
      .combine('vectorize', [undefined, 2, 3, 4] as const)
  )
  .fn(async t => {
    const cases = (await d.get('abstract_const')).filter(c => validForConst(c));
    await run(
      t,
      abstractFloatBuiltin('smoothstep'),
      [Type.abstractFloat, Type.abstractFloat, Type.abstractFloat],
      Type.abstractFloat,
      t.params,
      cases
    );
  });

g.test('f32')
  .specURL('https://www.w3.org/TR/WGSL/#float-builtin-functions')
  .desc(`f32 tests`)
  .params(u =>
    u.combine('inputSource', allInputSources).combine('vectorize', [undefined, 2, 3, 4] as const)
  )
  .fn(async t => {
    const cases = await d.get(t.params.inputSource === 'const' ? 'f32_const' : 'f32_non_const');
    const validCases = cases.filter(c => t.params.inputSource !== 'const' || validForConst(c));
    await run(
      t,
      builtin('smoothstep'),
      [Type.f32, Type.f32, Type.f32],
      Type.f32,
      t.params,
      validCases
    );
  });

g.test('f16')
  .specURL('https://www.w3.org/TR/WGSL/#float-builtin-functions')
  .desc(`f16 tests`)
  .params(u =>
    u.combine('inputSource', allInputSources).combine('vectorize', [undefined, 2, 3, 4] as const)
  )
  .beforeAllSubcases(t => {
    t.selectDeviceOrSkipTestCase('shader-f16');
  })
  .fn(async t => {
    const cases = await d.get(t.params.inputSource === 'const' ? 'f16_const' : 'f16_non_const');
    const validCases = cases.filter(c => t.params.inputSource !== 'const' || validForConst(c));
    await run(
      t,
      builtin('smoothstep'),
      [Type.f16, Type.f16, Type.f16],
      Type.f16,
      t.params,
      validCases
    );
  });

g.test('negative')
  .desc('test negative values that are supposed to be illegal')
  .fn(async t => {
    const module = t.device.createShaderModule({
      code: `
      @group(0) @binding(0) var<storage> values: array<f32>;
      @group(0) @binding(1) var<storage, read_write> results: array<f32>;

      @compute @workgroup_size(1) fn cs(
        @builtin(workgroup_id) workgroup_id : vec3<u32>,
        @builtin(num_workgroups) num_workgroups: vec3<u32>
      ) {
        let workgroup_index =
          workgroup_id.x +
          workgroup_id.y * num_workgroups.x +
          workgroup_id.z * num_workgroups.x * num_workgroups.y;

        results[workgroup_index] = smoothstep(
          values[workgroup_id.x],
          values[workgroup_id.y],
          values[workgroup_id.z],
        );
      }
    `,
    });

    const pipeline = t.device.createComputePipeline({
      layout: 'auto',
      compute: { module },
    });

    const values = [-100, -10, -1, -0.5, 0, 0.5, 1, -10, -100];
    const valuesBuffer = t.createBufferTracked({
      size: values.length * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    t.device.queue.writeBuffer(valuesBuffer, 0, new Float32Array(values));

    const resultsBuffer = t.createBufferTracked({
      size: values.length * values.length * values.length * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    const copyBuffer = t.createBufferTracked({
      size: resultsBuffer.size,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    const bindGroup = t.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: valuesBuffer } },
        { binding: 1, resource: { buffer: resultsBuffer } },
      ],
    });

    const encoder = t.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(values.length, values.length, values.length);
    pass.end();
    encoder.copyBufferToBuffer(resultsBuffer, 0, copyBuffer, 0, resultsBuffer.size);
    t.device.queue.submit([encoder.finish()]);

    await copyBuffer.mapAsync(GPUMapMode.READ);
    const results = new Float32Array(copyBuffer.getMappedRange()).slice();
    copyBuffer.unmap();

    /*
    t = clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
    */
    const smoothStep = (edge0: number, edge1: number, x: number) => {
      if (edge0 === edge1) {
        return edge0 < x ? 1 : 0; // should be NaN by definition but!??
      }
      const t = clamp((x - edge0) / (edge1 - edge0), { min: 0, max: 1 });
      return t * t * (3 - 2 * t);
    };

    const kMaxDiff = 0.000001;
    const errors = [];
    for (let z = 0; z < values.length; ++z) {
      for (let y = 0; y < values.length; ++y) {
        for (let x = 0; x < values.length; ++x) {
          const offset = z * values.length * values.length + y * values.length + x;
          const result = results[offset];
          const expect = smoothStep(values[x], values[y], values[z]);
          if (Math.abs(result - expect) > kMaxDiff) {
            errors.push(
              `smoothstep(${values[x]}, ${values[y]}, ${values[z]}) expected ${expect}, actual: ${result}`
            );
          }
        }
      }
    }

    if (errors.length > 0) {
      throw new Error(errors.join('\n'));
    }
  });
