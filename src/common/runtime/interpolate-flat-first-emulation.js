/*

Emulate interpolate-flat-first on device that only supports interpolate-flat-last

To do this we need to know if a render pipeline uses flat which means we need to
parse the shader. If it does, we need to record which index buffers are used
with that pipeline, record how they are used, and then copy the index buffer
and rotate the indices and change the commands to use this new index buffer.

Ideally we'd insert these copy and rotate in the same ....

*/

import {
    makeShaderDataDefinitions,
    getPipelineInfo,
    pipelineUsesFlatInterpolation,
} from './webgpu-utils.module.js';

const s_moduleToDefs = new WeakMap();
const s_passEncoderToPipeline = new WeakMap();
const s_pipelineUsesInterpolationFlat = new WeakMap();
const s_passEncoderToCommands = new WeakMap();
const s_passEncoderToIndexBufferInfo = new WeakMap();

const s_origFns = {};

GPUDevice.prototype.createShaderModule = (function(origFn) {
  return function(desc) {
    const module = origFn.call(this, desc);
    s_moduleToDefs.set(module, makeShaderDataDefinitions(desc.code));
    return module;
  };
})(GPUDevice.prototype.createShaderModule);

function registerPipeline(pipeline, desc) {
  const defs = [
    ...(s_moduleToDefs(desc.vertex.module) || []),
    ...(s_moduleToDefs(desc.fragment?.module) || []),
  ];
  s_pipelineUsesInterpolationFlat.set(pipeline, pipelineUsesFlatInterpolation(getPipelineInfo(defs, desc)));
}

function encodeExistingCommands(passEncoder) {
  const commands = s_passEncoderToCommands.get(passEncoder) || [];
  for (const {fnName, args} of commands) {
    s_origFns[fnName].call(this, ...args);
  }
  commands.length = 0;
}

[
  "executeBundles",
  "insertDebugMarker",
  "pushDebugGroup",
  "setBindGroup",
  "setBlendConstant",
  "setIndexBuffer",
  "writeTimestamp",
  "beginOcclusionQuery",
  "draw",
  "drawIndexed",
  "drawIndexedIndirect",
  "drawIndirect",
  //"end",
  "endOcclusionQuery",
  "popDebugGroup",
  "setPipeline",
  "setScissorRect",
  "setStencilReference",
  "setVertexBuffer",
  "setViewport"
].forEach(fnName => {
  GPURenderPassEncoder.prototype[fnName] = (function(origFn) {
    s_origFns[fnName] = origFn;
    return function (...args) {
      const commands = s_passEncoderToCommands.get(this) || [];
      s_passEncoderToCommands.set(this, commands);
      commands.push({fnName, args});
    };
  })(GPURenderPassEncoder.prototype[fnName]);
})

GPUDevice.prototype.createRenderPipeline = (function(origFn) {
  return function(desc) {
    const pipeline = origFn.call(this, desc);
    registerPipeline(pipeline, desc);
    return pipeline;
  };
})(GPUDevice.prototype.createRenderPipeline);

GPUDevice.prototype.createRenderPipelineAsync = (function(origFn) {
  return async function(desc) {
    const pipeline = await origFn.call(this, desc);
    registerPipeline(pipeline, desc);
    return pipeline;
  };
})(GPUDevice.prototype.createRenderPipelineAsync);

GPURenderPassEncoder.prototype.setPipeline = (function(origFn) {
  return function(pipeline) {
    origFn.call(this, pipeline);
    s_passEncoderToPipeline.set(this, pipeline);
  };
})(GPURenderPassEncoder.prototype.setPipeline);

GPURenderPassEncoder.prototype.setIndexBuffer = (function(origFn) {
  return function(buffer, format, offset = 0, size) {
    size = size === undefined ? buffer.size - offset : size;
    origFn.call(this, buffer, format, offset, size);
    s_passEncoderToIndexBufferInfo.set(this, {buffer, format, offset, size});
  };
})(GPURenderPassEncoder.prototype.setIndexBuffer);

GPURenderPassEncoder.prototype.draw = (function(origFn) {
  return function(...args) {
    const [vertexCount, instanceCount = 0, firstVertex = 0, firstInstance = 0] = args;
    const pipeline = s_passEncoderToPipeline.get(this);
    if (s_pipelineUsesInterpolationFlat.get(pipeline)) {
      updateGenericBuffer(this, firstVertex, vertexCount);
    }
    origFn.call(this, ...args);
  };
})(GPURenderPassEncoder.prototype.draw);

GPURenderPassEncoder.prototype.drawIndexed = (function(origFn) {
  return function(...args) {
    const pipeline = s_passEncoderToPipeline.get(this);
    if (s_pipelineUsesInterpolationFlat.get(pipeline)) {
      // record index_count and first_index for currrent indexbuffer
    }
    origFn.call(this, ...args);
  };
})(GPURenderPassEncoder.prototype.drawIndexed);

GPURenderPassEncoder.prototype.drawIndirect = (function(origFn) {
  return function(...args) {
    const pipeline = s_passEncoderToPipeline.get(this);
    if (s_pipelineUsesInterpolationFlat.get(pipeline)) {
      const {size, offset, format} = s_passEncoderToIndexBufferInfo.get(this);
      const indexSize = getIndexSize(format);
      updateGenericBuffer(this, 0, );

      // record index_count as size of indexbuffer currrent indexbuffer
    }
    origFn.call(this, ...args);
  };
})(GPURenderPassEncoder.prototype.drawIndirect);

GPURenderPassEncoder.prototype.drawIndexedIndirect = (function(origFn) {
  return function(...args) {
    const pipeline = s_passEncoderToPipeline.get(this);
    if (s_pipelineUsesInterpolationFlat.get(pipeline)) {
      // record index_count as size of indexbuffer currrent indexbuffer
    }
    origFn.call(this, ...args);
  };
})(GPURenderPassEncoder.prototype.drawIndexedIndirect);
