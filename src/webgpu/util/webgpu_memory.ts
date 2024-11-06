/* eslint-disable @typescript-eslint/no-explicit-any */
import { kTextureFormatInfo } from '../format_info.js';

type Category = string;

type ComputeMemSizeFn = (...args: any[]) => number;

const webgpuMemoryIdSymbol = Symbol('webgpu-memory-object-id');
const deviceIdToDeviceWeakRef = new Map<number, WeakRef<GPUDevice>>();

function setIdOnObject(obj: any, id: number) {
  obj[webgpuMemoryIdSymbol] = id;
}

function getIdOfObject(obj: any) {
  return obj[webgpuMemoryIdSymbol];
}

type ObjectInfo = {
  ref: WeakRef<GPUObjectBase | GPUCanvasContext>; // ref to object
  id: number; // id object's id (same as key)
  deviceId: number; // deviceId object's device
  category: Category; // category
  size: number | ComputeMemSizeFn;
};

let nextId = 1;
const allWebGPUObjectsById = new Map<number, ObjectInfo>();

/**
 * Start tracking a resource by device
 */
function addDeviceObject(
  device: GPUDevice,
  webgpuObject: GPUObjectBase | GPUCanvasContext,
  category: Category,
  size: number | ComputeMemSizeFn
) {
  let id = getIdOfObject(webgpuObject);
  if (!id) {
    id = nextId++;
    setIdOnObject(webgpuObject, id);
  }
  allWebGPUObjectsById.set(id, {
    ref: new WeakRef(webgpuObject),
    id,
    deviceId: getIdOfObject(device),
    category,
    size,
  });
}

/**
 * Start tracking a resource by device
 */
function addDeviceMem(
  device: GPUDevice,
  webgpuObject: GPUObjectBase | GPUCanvasContext,
  category: Category,
  size: number | ComputeMemSizeFn
) {
  addDeviceObject(device, webgpuObject, category, size);
}

/**
 * @returns true if device still exists
 */
function deviceExists(deviceId: number) {
  const ref = deviceIdToDeviceWeakRef.get(deviceId);
  return ref && !!ref.deref();
}

/**
 * Free an object's memory
 */
function freeObjectById(id: number) {
  allWebGPUObjectsById.delete(id);
}

/**
 * Free the memory used by object.
 * @param {GPUTexture | GPUBuffer} webgpuObject
 * @param {string} category
 */
function freeObject(webgpuObject: GPUObjectBase | GPUCanvasContext, category: Category) {
  const id = getIdOfObject(webgpuObject);
  freeObjectById(id);
}

type WebGPUMemoryInfo = {
  memory: Record<Category, number>;
  resources: Record<Category, number>;
};

/**
 * Gets WebGPU memory usage. If no device is passed in returns info for all devices.
 */
export function getWebGPUMemoryUsage(device?: GPUDevice): WebGPUMemoryInfo {
  const memory = {
    total: 0,
    buffer: 0,
    texture: 0,
    querySet: 0,
    canvas: 0,
  };
  const resources = {
    buffer: 0,
    texture: 0,
  };
  const info = { memory, resources };

  const requestedDeviceId = device && getIdOfObject(device);

  const idsToDelete = [];
  for (const [id, { ref, deviceId, category, size }] of allWebGPUObjectsById.entries()) {
    const webgpuObject = ref.deref();
    if (!webgpuObject || !deviceExists(deviceId)) {
      idsToDelete.push(id);
    } else {
      if (!requestedDeviceId || deviceId === requestedDeviceId) {
        (resources as unknown as any)[category] =
          ((resources as unknown as any)[category] || 0) + 1;
        if (size) {
          const numBytes = typeof size === 'function' ? size(webgpuObject) : size;
          memory.total += numBytes;
          (memory as unknown as any)[category] += numBytes;
        }
      }
    }
  }

  idsToDelete.forEach(freeObjectById);

  return info;
}

/**
 *
 * @param {GPUTexture} texture
 * @returns {number} approximate number of bytes used by texture.
 */
function computeTextureMemorySize(texture: {
  width: number;
  height: number;
  depthOrArrayLayers: number;
  format: GPUTextureFormat;
  sampleCount: number;
  mipLevelCount: number;
  dimension: GPUTextureDimension;
}) {
  const { blockWidth, blockHeight, bytesPerBlock } = kTextureFormatInfo[texture.format];

  let size = 0;
  let width = texture.width;
  let height = texture.height;
  let depth = texture.dimension === '3d' ? texture.depthOrArrayLayers : 1;
  const layers = texture.dimension === '3d' ? 1 : texture.depthOrArrayLayers;

  for (let level = 0; level < texture.mipLevelCount; ++level) {
    const blocksAcross = Math.ceil((texture.width * texture.sampleCount) / blockWidth);
    const blocksDown = Math.ceil((texture.height * texture.sampleCount) / blockHeight);
    const numBlocks = blocksAcross * blocksDown;
    const bytesUsed = numBlocks * bytesPerBlock!;
    size += bytesUsed;
    width = Math.max(1, (width / 2) | 0);
    height = Math.max(1, (height / 2) | 0);
    depth = Math.max(1, depth / 2);
  }

  size *= layers;

  return size;
}

function wrapFunction<
  K extends PropertyKey,
  T extends Record<K, (...args: Parameters<T[K]>) => ReturnType<T[K]>>,
>(
  API: { prototype: T },
  fnName: K,
  fn: (o: T, obj: ReturnType<T[K]>, ...args: Parameters<T[K]>) => void
) {
  const origFn = API.prototype[fnName];
  (API as unknown as any).prototype[fnName] = function (this: T, ...args: Parameters<T[K]>) {
    const result = origFn.call(this, ...args);
    fn(this, result, ...args);
    return result;
  };
}

function wrapAsyncFunction<
  K extends PropertyKey,
  T extends Record<K, (...args: Parameters<T[K]>) => ReturnType<T[K]>>,
>(
  API: { prototype: T },
  fnName: K,
  fn: (o: T, obj: Awaited<ReturnType<T[K]>>, ...args: Parameters<T[K]>) => void
) {
  const origFn = API.prototype[fnName];
  (API as unknown as any).prototype[fnName] = async function (this: T, ...args: Parameters<T[K]>) {
    const result = await (origFn as unknown as any).call(this, ...(args as unknown as any));
    fn(this, result, ...args);
    return result;
  };
}

function addBuffer(device: GPUDevice, buffer: GPUBuffer) {
  const bytesUsed = buffer.size;
  addDeviceMem(device, buffer, 'buffer', bytesUsed);
}

function removeBuffer(buffer: GPUBuffer) {
  freeObject(buffer, 'buffer');
}

function addTexture(device: GPUDevice, texture: GPUTexture) {
  const bytesUsed = computeTextureMemorySize(texture);
  addDeviceMem(device, texture, 'texture', bytesUsed);
}

function removeTexture(texture: GPUTexture) {
  freeObject(texture, 'texture');
}

function addQuerySet(device: GPUDevice, querySet: GPUQuerySet) {
  const bytesUsed = querySet.count * 8;
  addDeviceMem(device, querySet, 'querySet', bytesUsed);
}

function removeQuerySet(querySet: GPUQuerySet) {
  freeObject(querySet, 'querySet');
}

function addDevice(adapter: GPUAdapter, device: GPUDevice) {
  const id = nextId++;
  setIdOnObject(device, id);
  deviceIdToDeviceWeakRef.set(id, new WeakRef(device));
}

function removeDevice(device: GPUDevice) {
  const id = getIdOfObject(device);
  deviceIdToDeviceWeakRef.delete(id);
}

// assuming there are, in general, 2 textures per canvas.
// The one being displayed and the one being rendered to
const kTexturesPerCanvas = 2;

function computeCanvasBytesUsed(context: GPUCanvasContext, format: GPUTextureFormat) {
  const { width, height } = context.canvas;
  return (
    computeTextureMemorySize({
      format,
      width,
      height,
      depthOrArrayLayers: 1,
      sampleCount: 1,
      mipLevelCount: 1,
      dimension: '2d',
    }) * kTexturesPerCanvas
  );
}

function addContext(context: GPUCanvasContext, nothing: void, config: GPUCanvasConfiguration) {
  freeObject(context, 'canvas');
  const format = config.format;
  addDeviceMem(config.device, context, 'canvas', (context: GPUCanvasContext) =>
    computeCanvasBytesUsed(context, format)
  );
}

function removeContext(context: GPUCanvasContext) {
  freeObject(context, 'canvas');
}

function wrapCreationDestroy<
  T extends { new (...args: any[]): any },
  O extends { new (...args: any[]): any },
>(factoryClass: T, objectClass: O, fnName: string, category: Category) {
  wrapFunction(factoryClass, fnName, (device: GPUDevice, object: GPUObjectBase) => {
    addDeviceObject(device, object, category, 0);
  });
  if (objectClass.prototype.destroy) {
    wrapFunction(objectClass, 'destroy', (object: GPUObjectBase) => {
      freeObject(object, category);
    });
  }
}

if (typeof GPUAdapter !== 'undefined') {
  wrapAsyncFunction(GPUAdapter, 'requestDevice', addDevice);
  wrapFunction(GPUDevice, 'destroy', removeDevice);

  wrapFunction(GPUCanvasContext, 'configure', addContext);
  wrapFunction(GPUCanvasContext, 'unconfigure', removeContext);

  wrapFunction(GPUDevice, 'createBuffer', addBuffer);
  wrapFunction(GPUBuffer, 'destroy', removeBuffer);
  wrapFunction(GPUDevice, 'createTexture', addTexture);
  wrapFunction(GPUTexture, 'destroy', removeTexture);
  wrapFunction(GPUDevice, 'createQuerySet', addQuerySet);
  wrapFunction(GPUQuerySet, 'destroy', removeQuerySet);

  wrapCreationDestroy(GPUDevice, GPUSampler, 'createSampler', 'sampler');
  wrapCreationDestroy(GPUDevice, GPUBindGroup, 'createBindGroup', 'bindGroup');
  wrapCreationDestroy(GPUDevice, GPUBindGroupLayout, 'createBindGroupLayout', 'bindGroupLayout');
  wrapCreationDestroy(GPUDevice, GPUPipelineLayout, 'createPipelineLayout', 'pipelineLayout');
  wrapCreationDestroy(GPUDevice, GPUShaderModule, 'createShaderModule', 'shaderModule');
  wrapCreationDestroy(GPUDevice, GPUComputePipeline, 'createComputePipeline', 'computePipeline');
  wrapCreationDestroy(GPUDevice, GPURenderPipeline, 'createRenderPipeline', 'renderPipeline');
  wrapCreationDestroy(
    GPUDevice,
    GPUComputePipeline,
    'createComputePipelineAsync',
    'computePipeline'
  );
  wrapCreationDestroy(GPUDevice, GPURenderPipeline, 'createRenderPipelineAsync', 'renderPipeline');
  //wrapCreationDestroy(GPUDevice, GPUCommandEncoder, 'createCommandEncoder', 'commandEncoder');
  //wrapCreationDestroy(GPUDevice, GPURenderBundleEncoder, 'createRenderBundleEncoder', 'renderBundleEncoder');
  wrapCreationDestroy(GPUDevice, GPUQuerySet, 'createQuerySet', 'querySet');
  // problem, no device for this
  // GPURenderBundleEncoder, 'finish'
}
