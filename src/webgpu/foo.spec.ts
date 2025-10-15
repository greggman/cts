export const description = `
Tests the tests
`;

import { makeTestGroup } from '../common/framework/test_group.js';

import { AllFeaturesMaxLimitsGPUTest } from './gpu_test.js';

export const g = makeTestGroup(AllFeaturesMaxLimitsGPUTest);

g.test('should_fail')
  .desc('this test should fail')
  .fn(t => {
    const encoder = t.device.createCommandEncoder();
    const badTexture = t.createTextureTracked({
      size: [100000], // too big!
      format: 'rgba8unorm',
      usage: GPUTextureUsage.COPY_SRC, // NOT RENDERABLE
    });
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: badTexture.createView(),
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    pass.end();
    t.device.queue.submit([encoder.finish()]);
  });
