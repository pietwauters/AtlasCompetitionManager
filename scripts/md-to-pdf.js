'use strict';

/**
 * Generic Markdown -> A4 PDF converter, for printing docs like docs/level2.md.
 *
 * Usage:  node scripts/md-to-pdf.js <input.md> [output.pdf]
 *
 * Output defaults to the input path with its extension swapped to .pdf, so
 * the PDF lands next to the source file unless told otherwise.
 */

const fs = require('fs');
const path = require('path');
const { marked } = require('marked');
const puppeteer = require('puppeteer');

const [, , inputArg, outputArg] = process.argv;

if (!inputArg) {
  console.error('Usage: node scripts/md-to-pdf.js <input.md> [output.pdf]');
  process.exit(1);
}

const inputPath = path.resolve(inputArg);
const outputPath = path.resolve(outputArg || inputPath.replace(/\.md$/i, '.pdf'));

function buildHtml(markdownText, title) {
  const body = marked.parse(markdownText, { gfm: true });
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  body {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 10.5pt;
    line-height: 1.45;
    color: #111;
  }
  h1, h2, h3, h4 { font-family: Arial, Helvetica, sans-serif; break-after: avoid; }
  h1 { font-size: 20pt; border-bottom: 2px solid #333; padding-bottom: 4pt; margin-top: 0; }
  h2 { font-size: 15pt; margin-top: 22pt; border-bottom: 1px solid #999; padding-bottom: 2pt; }
  h3 { font-size: 12.5pt; margin-top: 16pt; }
  h4 { font-size: 11pt; margin-top: 12pt; }
  p, li { orphans: 3; widows: 3; }
  code {
    font-family: 'DejaVu Sans Mono', Consolas, monospace;
    font-size: 8.8pt;
    background: #f2f2f2;
    padding: 1px 3px;
    border-radius: 2px;
  }
  pre {
    background: #f5f5f5;
    border: 1px solid #ddd;
    border-radius: 4px;
    padding: 8pt;
    overflow-x: auto;
    break-inside: avoid;
  }
  pre code { background: none; padding: 0; font-size: 8.3pt; line-height: 1.35; }
  table { border-collapse: collapse; width: 100%; margin: 10pt 0; font-size: 9pt; break-inside: avoid; }
  th, td { border: 1px solid #bbb; padding: 3pt 6pt; text-align: left; vertical-align: top; }
  th { background: #e8e8e8; font-family: Arial, Helvetica, sans-serif; }
  a { color: #0645AD; text-decoration: none; }
  hr { border: none; border-top: 1px solid #ccc; margin: 14pt 0; }
  blockquote { border-left: 3px solid #ccc; margin: 8pt 0; padding: 2pt 10pt; color: #444; }
  ul, ol { margin: 4pt 0; padding-left: 20pt; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

async function main() {
  const markdownText = fs.readFileSync(inputPath, 'utf8');
  const firstHeading = markdownText.match(/^#\s+(.+)$/m);
  const title = firstHeading ? firstHeading[1].trim() : path.basename(inputPath, '.md');

  const html = buildHtml(markdownText, title);

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.pdf({ path: outputPath, format: 'A4', printBackground: true });
  } finally {
    await browser.close();
  }

  console.log(`Wrote ${outputPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
