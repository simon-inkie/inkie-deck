/**
 * generate-icons.mjs - one-off PWA + favicon icon generation (TASK-470 / TASK-472).
 * Teal rounded square + cream MC wordmark, Inkie design tokens
 * (#1a7a7a teal / #fffdf5 cream). Outputs public/icons/mc-{192,512}.png
 * + apple-touch-icon (180), plus the browser-tab favicon set
 * (public/favicon.svg + favicon-{16,32}.png). Assets are committed;
 * rerun only to restyle.
 */
import { Resvg } from "@resvg/resvg-js";
import { writeFileSync, mkdirSync } from "node:fs";

const svg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="96" fill="#1a7a7a"/>
  <rect x="40" y="40" width="432" height="432" rx="72" fill="none" stroke="#fffdf5" stroke-opacity="0.25" stroke-width="8"/>
  <text x="256" y="318" text-anchor="middle" font-family="DejaVu Sans" font-weight="bold" font-size="200" letter-spacing="-8" fill="#fffdf5">MC</text>
</svg>`;

mkdirSync("public/icons", { recursive: true });
for (const size of [192, 512, 180]) {
  const png = new Resvg(svg(size), {
    fitTo: { mode: "width", value: size },
    font: { loadSystemFonts: true },
  }).render().asPng();
  const name = size === 180 ? "apple-touch-icon.png" : `mc-${size}.png`;
  writeFileSync(`public/icons/${name}`, png);
  console.log(`public/icons/${name} (${png.length} bytes)`);
}

// Browser-tab favicon: a simplified mark. The hairline inner border is dropped
// (it is invisible and aliases badly at 16-32px), and the MC wordmark is sized
// to fill the square so it stays legible in a tab. SVG is served for crisp
// scaling on hi-DPI + pinned tabs; the PNGs are the universal fallback.
const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="96" fill="#1a7a7a"/>
  <text x="256" y="338" text-anchor="middle" font-family="DejaVu Sans, system-ui, sans-serif" font-weight="bold" font-size="248" letter-spacing="-14" fill="#fffdf5">MC</text>
</svg>`;
writeFileSync("public/favicon.svg", faviconSvg);
for (const size of [16, 32]) {
  const png = new Resvg(faviconSvg, {
    fitTo: { mode: "width", value: size },
    font: { loadSystemFonts: true },
  }).render().asPng();
  writeFileSync(`public/favicon-${size}.png`, png);
  console.log(`public/favicon-${size}.png (${png.length} bytes)`);
}
console.log("public/favicon.svg");
