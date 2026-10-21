/**
 * Static Site Build Script for GitHub Pages
 * Copies index.html, styles.css, src/, and assets/ into dist/
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

for (const item of ['index.html', 'styles.css', 'src', 'assets']) {
  const srcPath = path.join(rootDir, item);
  const dstPath = path.join(distDir, item);
  fs.cpSync(srcPath, dstPath, { recursive: true });
}

// Create .nojekyll so GitHub Pages serves all files and folders unaltered
fs.writeFileSync(path.join(distDir, '.nojekyll'), '');

console.log('Built static site in dist/ for GitHub Pages.');
