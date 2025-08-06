/**
* AUTO-GENERATED - DO NOT EDIT. Source: https://github.com/gpuweb/cts
**/























// Note: There are 4 settings with 7 options each including undefined
// which is 2401 combinations. So we don't check them all. Just a few below.
export const kSwizzleTests = [
'uuuu',
'rgba',
'0000',
'1111',
'rrrr',
'gggg',
'bbbb',
'aaaa',
'abgr',
'gbar',
'barg',
'argb',
'0gba',
'r0ba',
'rg0a',
'rgb0',
'1gba',
'r1ba',
'rg1a',
'rgb1',
'ubga',
'ruga',
'rbua',
'rbgu'];



const kSwizzleLetterToComponent = {
  u: undefined,
  r: 'r',
  g: 'g',
  b: 'b',
  a: 'a',
  '0': 'zero',
  '1': 'one'
};

const kComponents = ['r', 'g', 'b', 'a'];

export function swizzleSpecToGPUTextureComponentSwizzle(spec) {
  const swizzle = {};
  kComponents.forEach((component, i) => {
    const v = kSwizzleLetterToComponent[spec[i]];
    if (v) {
      swizzle[component] = v;
    }
  });
  return swizzle;
}

function swizzleComponentToTexelComponent(
src,
component)
{
  switch (component) {
    case 'zero':
      return 0;
    case 'one':
      return 1;
    case 'r':
      return src.R;
    case 'g':
      return src.G;
    case 'b':
      return src.B;
    case 'a':
      return src.A;
  }
}

export function swizzleTexel(
src,
swizzle)
{
  return {
    R: swizzle.r ? swizzleComponentToTexelComponent(src, swizzle.r) : src.R,
    G: swizzle.g ? swizzleComponentToTexelComponent(src, swizzle.g) : src.G,
    B: swizzle.b ? swizzleComponentToTexelComponent(src, swizzle.b) : src.B,
    A: swizzle.a ? swizzleComponentToTexelComponent(src, swizzle.a) : src.A
  };
}

export function isIdentitySwizzle(swizzle) {
  return (
    (swizzle.r === undefined || swizzle.r === 'r') && (
    swizzle.g === undefined || swizzle.g === 'g') && (
    swizzle.b === undefined || swizzle.b === 'b') && (
    swizzle.a === undefined || swizzle.a === 'a'));

}

function normalizeSwizzle(swizzle) {
  return {
    r: swizzle.r ?? 'r',
    g: swizzle.g ?? 'g',
    b: swizzle.b ?? 'b',
    a: swizzle.a ?? 'a'
  };
}

export function swizzlesAreTheSame(
a,
b)
{
  a = normalizeSwizzle(a);
  b = normalizeSwizzle(b);
  return a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
}