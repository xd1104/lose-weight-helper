'use strict';

/*
 * build.js — 從單一前端來源 public/ 鏡射出 GitHub Pages 站（docs/）。
 * server.js 啟動時會自動呼叫（保證從任何入口啟動 docs/ 都不落後 public/）；
 * 也可手動 `node build.js`。docs/ 永遠是產物，別手改——每次 build 整個重建。
 *
 * GitHub Pages「Deploy from a branch」只能選 repo root 或 /docs，
 * 不能直接服務 public/，所以鏡射一份。前端全部用相對路徑，
 * 同一份檔案在 localhost 根目錄與 Pages 子路徑（/lose-weight-helper/）都能跑。
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'public');
const OUT = path.join(ROOT, 'docs');

function build() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.cpSync(SRC, OUT, { recursive: true });
  // .nojekyll：讓 GitHub Pages 不要用 Jekyll 過濾檔案
  fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
  const count = fs.readdirSync(OUT).length;
  console.log('[build] docs/ generated from public/ (' + count + ' top-level entries)');
}

module.exports = { build };

if (require.main === module) build();
