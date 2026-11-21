'use strict';

(() => {
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s, l = (max + min) / 2;
    if (max === min) h = s = 0;
    else {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        case b: h = (r - g) / d + 4; break;
      }
      h /= 6;
    }
    return [h * 360, s, l];
  }

  function hslToRgb(h, s, l) {
    h /= 360;
    let r, g, b;
    if (s === 0) r = g = b = l;
    else {
      const hue2rgb = (p, q, t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1/6) return p + (q - p) * 6 * t;
        if (t < 1/2) return q;
        if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
        return p;
      };
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1/3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1/3);
    }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
  }

  function accentText(rgb, isLight) {
    if (!isLight) return `color-mix(in srgb, rgb(${rgb.join(' ')}) 65%, white)`;
    const [h, s] = rgbToHsl(...rgb);
    const lightness = h >= 35 && h <= 165 ? 0.25 : 0.32;
    // Gray has no hue; increasing its saturation would invent a red accent.
    const saturation = s < 0.05 ? s : Math.min(0.85, Math.max(0.55, s * 0.9));
    return `rgb(${hslToRgb(h, saturation, lightness).join(' ')})`;
  }

  function petalShade(rgb, shade) {
    const target = shade < 0 ? 0 : 255;
    return `rgb(${rgb.map(c => Math.round(c + (target - c) * Math.abs(shade))).join(', ')})`;
  }

  const colors = { rgbToHsl, hslToRgb, accentText, petalShade };
  if (typeof module !== 'undefined' && module.exports) module.exports = colors;
  else window.launcherColors = colors;
})();
