/**
 * 所有打包图标只从 brand/*.svg 生成：窗口 / exe / 安装包 / 网页 favicon。
 */
import { Resvg } from "@resvg/resvg-js";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BRAND = join(ROOT, "brand");
const MARK = join(BRAND, "oneledger.svg");
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

function readSvg(path, label) {
  const text = readFileSync(path, "utf8");
  if (!text.includes("<svg")) {
    throw new Error(`${label} 不是 SVG`);
  }
  return text;
}

function raster(svg, width) {
  const rendered = new Resvg(svg, {
    fitTo: { mode: "width", value: width },
    font: { loadSystemFonts: false },
  }).render();
  return {
    png: rendered.asPng(),
    pixels: rendered.pixels,
    width: rendered.width,
    height: rendered.height,
  };
}

function encodeIco(images) {
  const header = 6 + 16 * images.length;
  let offset = header;
  const entries = images.map((image) => {
    const entry = { image, offset };
    offset += image.png.length;
    return entry;
  });
  const out = Buffer.alloc(offset);
  out.writeUInt16LE(0, 0);
  out.writeUInt16LE(1, 2);
  out.writeUInt16LE(images.length, 4);
  let cursor = 6;
  for (const { image, offset: start } of entries) {
    out[cursor] = image.width >= 256 ? 0 : image.width;
    out[cursor + 1] = image.height >= 256 ? 0 : image.height;
    out[cursor + 2] = 0;
    out[cursor + 3] = 0;
    out.writeUInt16LE(1, cursor + 4);
    out.writeUInt16LE(32, cursor + 6);
    out.writeUInt32LE(image.png.length, cursor + 8);
    out.writeUInt32LE(start, cursor + 12);
    image.png.copy(out, start);
    cursor += 16;
  }
  return out;
}

function encodeBmp24(width, height, rgba) {
  const row = Math.floor((width * 3 + 3) / 4) * 4;
  const pixels = row * height;
  const out = Buffer.alloc(54 + pixels);
  out.write("BM", 0);
  out.writeUInt32LE(54 + pixels, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(width, 18);
  out.writeInt32LE(height, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(pixels, 34);
  let pos = 54;
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      out[pos++] = rgba[i + 2];
      out[pos++] = rgba[i + 1];
      out[pos++] = rgba[i];
    }
    pos += row - width * 3;
  }
  return out;
}

function writePng(dir, name, png) {
  writeFileSync(join(dir, name), png);
}

function main() {
  const mark = readSvg(MARK, "brand/oneledger.svg");
  const header = readSvg(join(BRAND, "nsis-header.svg"), "brand/nsis-header.svg");
  const sidebar = readSvg(join(BRAND, "nsis-sidebar.svg"), "brand/nsis-sidebar.svg");

  const tauriIcons = join(ROOT, "src-tauri", "icons");
  const desktopIcons = join(ROOT, "desktop", "icons");
  const webPublic = join(ROOT, "web", "public");
  mkdirSync(tauriIcons, { recursive: true });
  mkdirSync(desktopIcons, { recursive: true });
  mkdirSync(webPublic, { recursive: true });

  copyFileSync(MARK, join(tauriIcons, "icon.svg"));
  copyFileSync(MARK, join(desktopIcons, "icon.svg"));
  copyFileSync(MARK, join(webPublic, "favicon.svg"));
  copyFileSync(MARK, join(webPublic, "oneledger.svg"));

  const squares = ICO_SIZES.map((size) => raster(mark, size));
  const icon512 = raster(mark, 512);
  const ico = encodeIco(squares);

  writeFileSync(join(tauriIcons, "icon.ico"), ico);
  writeFileSync(join(desktopIcons, "icon.ico"), ico);
  writePng(tauriIcons, "icon.png", icon512.png);
  writePng(desktopIcons, "icon.png", icon512.png);
  writePng(tauriIcons, "32x32.png", squares.find((item) => item.width === 32).png);
  writePng(tauriIcons, "128x128.png", squares.find((item) => item.width === 128).png);
  writePng(tauriIcons, "128x128@2x.png", raster(mark, 256).png);

  const headerBmp = raster(header, 150);
  const sidebarBmp = raster(sidebar, 164);
  writeFileSync(join(tauriIcons, "nsis-header.bmp"), encodeBmp24(headerBmp.width, headerBmp.height, headerBmp.pixels));
  writeFileSync(join(tauriIcons, "nsis-sidebar.bmp"), encodeBmp24(sidebarBmp.width, sidebarBmp.height, sidebarBmp.pixels));
  writeFileSync(join(tauriIcons, "installer.ico"), ico);

  if (headerBmp.width !== 150 || headerBmp.height !== 57) {
    throw new Error(`NSIS header 尺寸应为 150x57，实际 ${headerBmp.width}x${headerBmp.height}`);
  }
  if (sidebarBmp.width !== 164 || sidebarBmp.height !== 314) {
    throw new Error(`NSIS sidebar 尺寸应为 164x314，实际 ${sidebarBmp.width}x${sidebarBmp.height}`);
  }

  console.log("icons <- brand/oneledger.svg");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
