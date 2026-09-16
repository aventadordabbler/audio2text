import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import pngToIco from "png-to-ico";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const assetsDir = path.join(rootDir, "assets");
const svgPath = path.join(assetsDir, "logo.svg");
const pngPath = path.join(assetsDir, "icon.png");
const icoPath = path.join(assetsDir, "icon.ico");

const svgBuffer = await fs.readFile(svgPath);

await sharp(svgBuffer).resize(1024, 1024).png().toFile(pngPath);

const iconSizes = [256, 128, 64, 48, 32, 16];
const pngBuffers = await Promise.all(
  iconSizes.map((size) => sharp(svgBuffer).resize(size, size).png().toBuffer())
);

const icoBuffer = await pngToIco(pngBuffers);
await fs.writeFile(icoPath, icoBuffer);

console.log(`Generated ${path.relative(rootDir, pngPath)} and ${path.relative(rootDir, icoPath)}`);
