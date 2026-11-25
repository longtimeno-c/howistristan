#!/usr/bin/env node
// Bundles the page into dist/artifact.html: one self-contained fragment (styles and script inlined)
// for hosts that wrap the page themselves. The data files stay separate and are fetched from data/.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './lib.mjs';

const html = readFileSync(join(root, 'index.html'), 'utf8');
const body = html.slice(html.indexOf('<!-- page:start -->') + 19, html.indexOf('<!-- page:end -->'));
const fonts = /<link rel="stylesheet" href="https:\/\/fonts[^>]+>/.exec(html)[0];
const css = readFileSync(join(root, 'assets/style.css'), 'utf8');
const js = readFileSync(join(root, 'assets/app.js'), 'utf8');
const out = `<title>How is Tristan</title>
<meta name="claude:viewport-fit-sides" content="cover">
${fonts}
<style>
${css}</style>
${body.trim()}
<script>
${js.replace(/<\/script/g, '<\\/script')}</script>
`;
mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist/artifact.html'), out);
console.log(`dist/artifact.html ${(out.length / 1024).toFixed(1)} KB`);
