'use strict';
// One-time color-scale generator — NOT a build step, no runtime dependency.
// Run by hand (`node scripts/generate-color-scales.js`) whenever a scale needs
// (re)generating; paste the printed hex values into public/css/style.css, same
// as any other hand-authored token. Zero npm dependencies: the OKLCH<->sRGB
// math below is Björn Ottosson's public-domain OKLab formulas (the same base
// math CSS Color 4's oklch() and Radix Colors' own tooling use), implemented
// directly so this stays a plain, inspectable script.
//
// Recipe (Radix Colors' 12-step convention — see docs/... or the "Choosing a
// Color System" design-reference artifact for the reasoning):
//   1-2  app / subtle backgrounds
//   3-5  component background / hover / pressed
//   6-8  subtle border -> interactive border -> focus ring
//   9-10 solid fill / solid fill hover      <- real anchors, never invented
//   11-12 low-contrast text / high-contrast text, contrast-checked against
//         the theme's surface color (WCAG AA 4.5:1 / AAA 7:1)

// ---------------------------------------------------------------------------
// sRGB <-> OKLab/OKLCH
// ---------------------------------------------------------------------------
function hexToRgb(hex) {
  hex = hex.replace('#', '');
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  const n = parseInt(hex, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex([r, g, b]) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return '#' + c(r) + c(g) + c(b);
}
function srgbToLinear(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function linearToSrgb(c) {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055;
  return v * 255;
}
function rgbToOklab([r, g, b]) {
  const [lr, lg, lb] = [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
  const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
  return [
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  ];
}
function oklabToRgb([L, a, b]) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const lr = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  return [linearToSrgb(lr), linearToSrgb(lg), linearToSrgb(lb)];
}
function toLch([L, a, b]) {
  return [L, Math.sqrt(a * a + b * b), (Math.atan2(b, a) * 180) / Math.PI];
}
function fromLch([L, C, H]) {
  const rad = (H * Math.PI) / 180;
  return [L, C * Math.cos(rad), C * Math.sin(rad)];
}
function hexToOklch(hex) { return toLch(rgbToOklab(hexToRgb(hex))); }
function oklchToHex(lch) { return rgbToHex(oklabToRgb(fromLch(lch))); }

// ---------------------------------------------------------------------------
// WCAG relative luminance / contrast
// ---------------------------------------------------------------------------
function relLuminance([r, g, b]) {
  const [lr, lg, lb] = [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}
function contrast(hexA, hexB) {
  const a = relLuminance(hexToRgb(hexA)), b = relLuminance(hexToRgb(hexB));
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

// ---------------------------------------------------------------------------
// Scale generation
// ---------------------------------------------------------------------------
function easeIn(t, p) { return Math.pow(t, p); }

// Generate steps 1-8 by interpolating from a near-endpoint toward the step9
// anchor; step 9/10 are the real anchors; steps 11-12 are binary-searched
// for target WCAG contrast against `surfaceHex`, keeping hue/chroma from the
// anchors (slightly desaturated) fixed.
function generateScale({ name, theme, step9Hex, step10Hex, surfaceHex }) {
  const isDark = theme === 'dark';
  const [L9, C9, H9] = hexToOklch(step9Hex);
  const [, C10] = hexToOklch(step10Hex);
  const H = H9; // steps share one hue

  // Endpoint for steps 1-8: near-white (light theme) or near the dark
  // surface's own lightness (dark theme), both nudged toward H at low chroma.
  const [surfL] = hexToOklch(surfaceHex);
  const L1 = isDark ? Math.max(surfL - 0.02, 0.10) : Math.min(0.995, 0.99);
  const C1 = isDark ? 0.01 : 0.006;

  const steps = {};
  for (let i = 1; i <= 8; i++) {
    const t = (i - 1) / 8; // 0..0.875 across steps 1-8, approaching (not reaching) step 9
    const L = L1 + (L9 - L1) * easeIn(t, isDark ? 1.15 : 1.35);
    const C = C1 + (C9 - C1) * easeIn(t, 1.3);
    steps[i] = oklchToHex([L, C, H]);
  }
  steps[9] = step9Hex;
  steps[10] = step10Hex;

  // Steps 11/12: binary-search lightness for target contrast against surface,
  // reusing the anchor hue at slightly reduced chroma (keeps text from
  // looking neon while staying clearly "the same color family").
  const Ctext = Math.max(C9, C10) * 0.82;
  function searchForContrast(target) {
    // Binary search lightness in [0,1] for the boundary where contrast
    // against the surface crosses `target`, holding hue/chroma fixed.
    let lo = 0, hi = 1;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      const hex = oklchToHex([mid, Ctext, H]);
      const c = contrast(hex, surfaceHex);
      // In light theme we're darkening (lower L = more contrast vs white-ish surface).
      // In dark theme we're lightening (higher L = more contrast vs dark surface).
      const wantHigherL = isDark;
      if (c < target) {
        if (wantHigherL) lo = mid; else hi = mid;
      } else {
        if (wantHigherL) hi = mid; else lo = mid;
      }
    }
    const finalL = isDark ? lo : hi;
    return oklchToHex([finalL, Ctext, H]);
  }
  steps[11] = searchForContrast(4.5);
  steps[12] = searchForContrast(7.0);

  return steps;
}

function printScale(label, theme, steps, surfaceHex) {
  console.log(`\n${label} (${theme}):`);
  for (let i = 1; i <= 12; i++) {
    const hex = steps[i];
    let note = '';
    if (i === 11) note = `  [contrast vs surface: ${contrast(hex, surfaceHex).toFixed(2)}:1, target 4.5]`;
    if (i === 12) note = `  [contrast vs surface: ${contrast(hex, surfaceHex).toFixed(2)}:1, target 7.0]`;
    console.log(`  --${label}-${i}: ${hex};${note}`);
  }
}

// ---------------------------------------------------------------------------
// Phase A hue definitions
// ---------------------------------------------------------------------------
const SURFACE_LIGHT = '#ffffff';
const SURFACE_DARK = '#1a1d24';

const hues = [
  { name: 'brand', light: { 9: '#1a6bab', 10: '#155594' }, dark: { 9: '#3b82f6', 10: '#2563eb' } },
  { name: 'danger', light: { 9: '#c0392b', 10: '#a93226' }, dark: { 9: '#ef4444', 10: '#dc2626' } },
  { name: 'success', light: { 9: '#1e8449', 10: '#196b3c' }, dark: { 9: '#22c55e', 10: '#16a34a' } },
  { name: 'warn', light: { 9: '#ffc107', 10: '#e0a800' }, dark: { 9: '#fbbf24', 10: '#eab308' } },
  { name: 'info', light: { 9: '#4a6fa5', 10: '#3a5a87' }, dark: { 9: '#7fa8d9', 10: '#6090c5' } },
];

for (const h of hues) {
  const lightSteps = generateScale({ name: h.name, theme: 'light', step9Hex: h.light[9], step10Hex: h.light[10], surfaceHex: SURFACE_LIGHT });
  const darkSteps = generateScale({ name: h.name, theme: 'dark', step9Hex: h.dark[9], step10Hex: h.dark[10], surfaceHex: SURFACE_DARK });
  printScale(h.name, 'light', lightSteps, SURFACE_LIGHT);
  printScale(h.name, 'dark', darkSteps, SURFACE_DARK);
}

// Neutral/structural gray scale — pure lightness ramp, near-zero chroma,
// anchored on the app's real light/dark surface + text-muted values.
function generateNeutral(theme) {
  const isDark = theme === 'dark';
  const surface = isDark ? '#1a1d24' : '#ffffff';
  const [Ltext] = hexToOklch(isDark ? '#e2e8f0' : '#1a1a2e');
  const [Lsurf] = hexToOklch(surface);
  const steps = {};
  for (let i = 1; i <= 12; i++) {
    const t = (i - 1) / 11;
    const L = Lsurf + (Ltext - Lsurf) * easeIn(t, isDark ? 0.85 : 1.0);
    steps[i] = oklchToHex([L, 0.006, 250]); // faint cool bias, matches existing slate-ish grays
  }
  return steps;
}
printScale('neutral-gray', 'light', generateNeutral('light'), SURFACE_LIGHT);
printScale('neutral-gray', 'dark', generateNeutral('dark'), SURFACE_DARK);

// ---------------------------------------------------------------------------
// Phase B — badge-pair hues (bg+text only, no existing solid/hover buttons).
// Derive synthetic step9/10 anchors from the existing text color's hue, at a
// conventional "solid button" lightness, then run the same recipe.
// ---------------------------------------------------------------------------
function deriveAnchorsFromText(textHex, theme) {
  const [, C] = hexToOklch(textHex);
  const [, , H] = hexToOklch(textHex);
  const isDark = theme === 'dark';
  const L9 = isDark ? 0.68 : 0.50;
  const L10 = isDark ? 0.58 : 0.42;
  const C9 = Math.max(C, 0.09);
  return { step9: oklchToHex([L9, C9, H]), step10: oklchToHex([L10, C9, H]) };
}

console.log('\n\n=== Phase B ===');
const phaseB = [
  { name: 'de', light: { 9: '#8e44ad', 10: '#7d3c98' }, dark: { 9: '#a855f7', 10: '#9333ea' } },
  { name: 'neutralbadge', lightText: '#383d41', darkText: '#b8bec5' },
  { name: 'badgepool', lightText: '#1e40af', darkText: '#93c5fd' },
  { name: 'badgede', lightText: '#5b21b6', darkText: '#d8b4fe' },
  { name: 'active', lightText: '#084298', darkText: '#7db6f0' },
];

for (const h of phaseB) {
  const lightAnchors = h.light || deriveAnchorsFromText(h.lightText, 'light');
  const darkAnchors = h.dark || deriveAnchorsFromText(h.darkText, 'dark');
  const l9 = h.light ? h.light[9] : lightAnchors.step9;
  const l10 = h.light ? h.light[10] : lightAnchors.step10;
  const d9 = h.dark ? h.dark[9] : darkAnchors.step9;
  const d10 = h.dark ? h.dark[10] : darkAnchors.step10;
  const lightSteps = generateScale({ name: h.name, theme: 'light', step9Hex: l9, step10Hex: l10, surfaceHex: SURFACE_LIGHT });
  const darkSteps = generateScale({ name: h.name, theme: 'dark', step9Hex: d9, step10Hex: d10, surfaceHex: SURFACE_DARK });
  printScale(h.name, 'light', lightSteps, SURFACE_LIGHT);
  printScale(h.name, 'dark', darkSteps, SURFACE_DARK);
}
