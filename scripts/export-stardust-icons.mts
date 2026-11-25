import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import sharp from "sharp";
import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";
import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

const root = NodePath.resolve(import.meta.dirname, "..");
const source = NodePath.join(root, BRAND_ASSET_PATHS.stardustIconPng);
const destination = NodePath.join(root, BRAND_ASSET_PATHS.stardustWindowsIconIco);
const images = await Promise.all(
  WINDOWS_ICON_SIZES.map(async (size) => ({
    size,
    contents: await sharp(source).resize(size, size).png().toBuffer(),
  })),
);
await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
await NodeFSP.writeFile(destination, encodePngIco(images));
