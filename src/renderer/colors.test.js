'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { accentText, petalShade, rgbToHsl, hslToRgb } = require('./colors');

test('light gray accents stay gray instead of becoming cherry', () => {
  assert.equal(accentText([178, 178, 178], true), 'rgb(82 82 82)');
  assert.equal(accentText([0, 0, 0], true), 'rgb(82 82 82)');
  assert.equal(accentText([178, 178, 178], false), 'color-mix(in srgb, rgb(178 178 178) 65%, white)');
});

test('colored light accents preserve their hue and dark palettes stay unchanged', () => {
  for (const rgb of [[149, 170, 255], [244, 168, 190], [127, 221, 144]]) {
    const converted = hslToRgb(...rgbToHsl(...rgb));
    assert.deepEqual(converted, rgb);
    const light = accentText(rgb, true).match(/\d+/g).map(Number);
    assert.ok(Math.abs(rgbToHsl(...light)[0] - rgbToHsl(...rgb)[0]) < 2);
  }
});

test('petals use the live accent, retaining gray and clamping white/black endpoints', () => {
  assert.equal(petalShade([149, 170, 255], 0), 'rgb(149, 170, 255)');
  assert.equal(petalShade([221, 127, 129], 0), 'rgb(221, 127, 129)');
  assert.equal(petalShade([178, 178, 178], 0.1), 'rgb(186, 186, 186)');
  assert.equal(petalShade([178, 178, 178], -0.1), 'rgb(160, 160, 160)');
  assert.equal(petalShade([0, 0, 0], 1), 'rgb(255, 255, 255)');
  assert.equal(petalShade([255, 255, 255], -1), 'rgb(0, 0, 0)');
});
