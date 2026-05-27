#!/usr/bin/env node
// build.js - 压缩根目录 *.html *.css *.js，输出到 dist/
// edge-functions/ 和 cloud-functions/ 直接复制不压缩

import { minify as minifyHTML } from "html-minifier-terser";
import { minify as minifyJS } from "terser";
import CleanCSS from "clean-css";
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

const SRC = ".";
const DIST = "dist";
const COPY_DIRS = ["edge-functions", "cloud-functions"];
const SKIP_FILES = ["build.js", "warmup.js"]; // 构建脚本本身不打包

const css = new CleanCSS({ level: 2 });

async function main() {
  // 清空 dist
  await fs.rm(DIST, { recursive: true, force: true });
  await fs.mkdir(DIST, { recursive: true });

  const entries = await fs.readdir(SRC, { withFileTypes: true });
  const stats = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const { name } = entry;
    if (SKIP_FILES.includes(name)) continue;

    const ext = path.extname(name).toLowerCase();
    if (![".html", ".css", ".js"].includes(ext)) continue;

    const src = path.join(SRC, name);
    const dest = path.join(DIST, name);
    const original = await fs.readFile(src, "utf-8");
    let output = original;

    if (ext === ".html") {
      output = await minifyHTML(original, {
        collapseWhitespace: true,
        removeComments: true,
        minifyCSS: true,
        minifyJS: true,
      });
    } else if (ext === ".css") {
      output = css.minify(original).styles;
    } else if (ext === ".js") {
      const result = await minifyJS(original, { toplevel: false });
      output = result.code;
    }

    await fs.writeFile(dest, output);
    stats.push({ name, before: original.length, after: output.length });
  }

  // 复制 edge-functions / cloud-functions
  for (const dir of COPY_DIRS) {
    if (existsSync(dir)) {
      await fs.cp(dir, path.join(DIST, dir), { recursive: true });
      console.log(`copied  ${dir}/`);
    }
  }

  // 打印报告
  console.log("\n文件压缩报告：");
  let totalBefore = 0, totalAfter = 0;
  for (const { name, before, after } of stats) {
    const ratio = ((1 - after / before) * 100).toFixed(1);
    console.log(`  ${name.padEnd(20)} ${kb(before)} → ${kb(after)}  (-${ratio}%)`);
    totalBefore += before;
    totalAfter += after;
  }
  const totalRatio = ((1 - totalAfter / totalBefore) * 100).toFixed(1);
  console.log(`${"合计".padEnd(22)} ${kb(totalBefore)} → ${kb(totalAfter)}  (-${totalRatio}%)`);
}

function kb(n) {
  return (n / 1024).toFixed(2).padStart(7) + " KB";
}

main().catch((e) => { console.error(e); process.exit(1); });
