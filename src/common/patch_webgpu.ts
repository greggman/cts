/* eslint-disable no-console */
import { assert } from './util/util.js';

// Strange that this is missing.
declare class WeakRef<T> {
  constructor(o: T);
  deref(): T;
}
interface GPUAdapter {
  isCompatibilityMode?: boolean;
}

let patched = false;

export function patchWebGPU(gpu: GPU) {
  if (patched) {
    return;
  }

  patched = true;

  // Validate we're patching the correct thing
  assert(gpu instanceof GPU);

  type ErrorScopeStackEntry = {
    filter: GPUErrorFilter;
    errors: GPUError[];
  };
  const deviceIsCompatSet = new WeakSet<GPUDevice>();
  const deviceToErrorScopeStack = new WeakMap<GPUDevice, ErrorScopeStackEntry[]>();
  const textureToDeviceWeakMap = new WeakMap<GPUTexture, WeakRef<GPUDevice>>();

  function isDeviceCompat(device: GPUDevice) {
    return deviceIsCompatSet.has(device);
  }

  GPUAdapter.prototype.requestDevice = (function (origFn) {
    return async function (this: GPUAdapter, desc: GPUDeviceDescriptor | undefined) {
      const device = await origFn.call(this, desc);
      deviceToErrorScopeStack.set(device, []);
      if (this.isCompatibilityMode) {
        deviceIsCompatSet.add(device);
      }
      return device;
    };
    // eslint-disable-next-line @typescript-eslint/unbound-method
  })(GPUAdapter.prototype.requestDevice);

  GPUDevice.prototype.pushErrorScope = (function (
    origFn: typeof GPUDevice.prototype.pushErrorScope
  ) {
    return function (this: GPUDevice, filter: GPUErrorFilter) {
      const errorScopeStack = deviceToErrorScopeStack.get(this)!;
      errorScopeStack.push({ filter, errors: [] });
      return origFn.call(this, filter);
    };
    // eslint-disable-next-line @typescript-eslint/unbound-method
  })(GPUDevice.prototype.pushErrorScope);

  GPUDevice.prototype.popErrorScope = (function (origFn: typeof GPUDevice.prototype.popErrorScope) {
    return async function (this: GPUDevice) {
      const errorScopeStack = deviceToErrorScopeStack.get(this)!;
      const errorScope = errorScopeStack.pop();
      if (!errorScope) {
        throw new DOMException('popErrorScope called on empty error scope stack', 'OperationError');
      }
      const error = (await origFn.call(this)) || errorScope.errors.pop() || null;
      return error;
    };
    // eslint-disable-next-line @typescript-eslint/unbound-method
  })(GPUDevice.prototype.popErrorScope);

  function getFilterForGPUError(error: GPUError): GPUErrorFilter {
    if (error instanceof GPUValidationError) {
      return 'validation';
    }
    if (error instanceof GPUOutOfMemoryError) {
      return 'out-of-memory';
    }
    if (error instanceof GPUInternalError) {
      return 'internal';
    }
    throw new Error('unknown GPUError type');
  }

  // MAINTENANCE_TODO: replace with Array.prototype.findLast
  function findLast<T>(array: T[], predicate: (v: T) => boolean): T | undefined {
    for (let i = array.length - 1; i >= 0; --i) {
      const v = array[i];
      if (predicate(v)) {
        return v;
      }
    }
    return undefined;
  }

  function emitGPUError(device: GPUDevice, error: GPUError) {
    const filter = getFilterForGPUError(error);
    const errorScopeStack = deviceToErrorScopeStack.get(device)!;
    const currentErrorScope = findLast(errorScopeStack, scope => scope.filter === filter);
    if (currentErrorScope) {
      currentErrorScope.errors.push(error);
    } else {
      device.dispatchEvent(new GPUUncapturedErrorEvent('uncapturedError', { error }));
    }
  }

  GPUDevice.prototype.createTexture = (function (origFn: typeof GPUDevice.prototype.createTexture) {
    return function (this: GPUDevice, desc: GPUTextureDescriptor) {
      if (isDeviceCompat(this)) {
        const { dimension = '2d', format, viewFormats, size } = desc;
        const depthOrArrayLayers =
          (size as number[])[2] || (size as GPUExtent3DDictStrict).depthOrArrayLayers || 1;
        let textureBindingViewDimension: GPUTextureViewDimension = (
          desc as unknown as { textureBindingViewDimension: GPUTextureViewDimension }
        ).textureBindingViewDimension;
        if (!textureBindingViewDimension) {
          textureBindingViewDimension =
            dimension === '2d' ? (depthOrArrayLayers > 1 ? '2d-array' : '2d') : dimension;
        }
        if (textureBindingViewDimension === '2d' && depthOrArrayLayers !== 1) {
          emitGPUError(
            this,
            new GPUValidationError(
              `textureBindingViewDimension = 2d but depthOrArrayLayers = ${depthOrArrayLayers}`
            )
          );
        } else if (textureBindingViewDimension === 'cube' && depthOrArrayLayers !== 6) {
          emitGPUError(
            this,
            new GPUValidationError(
              `textureBindingViewDimension = cube but depthOrArrayLayers = ${depthOrArrayLayers}`
            )
          );
        }
        if (viewFormats) {
          const vfs = [...viewFormats!];
          if (vfs.findIndex(viewFormat => viewFormat !== format) >= 0) {
            emitGPUError(
              this,
              new GPUValidationError(
                `viewFormats ${vfs.join(', ')} must be the same as format ${format}`
              )
            );
          }
        }
      }
      const texture = origFn.call(this, desc);
      textureToDeviceWeakMap.set(texture, new WeakRef(this));
      return texture;
    };
    // eslint-disable-next-line @typescript-eslint/unbound-method
  })(GPUDevice.prototype.createTexture);
}
