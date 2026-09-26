'use strict';
// Shared by results.html and team-results.html: download a competition's
// FIE XML results file (GET /api/fie/export/:id). Fetched rather than a plain
// link so a refusal (e.g. no rounds yet) returns its message instead of
// downloading an error body as a file. Resolves to an error string, or '' on success.
async function downloadFieXml(compId) {
  const res = await fetch('/api/fie/export/' + compId);
  if (!res.ok) return (await res.json().catch(() => ({}))).error || 'Export failed.';
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '')?.[1] || 'results.xml';
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
  return '';
}
