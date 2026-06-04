'use strict';

/**
 * Atlas manual screenshot generator.
 *
 * Usage:  node scripts/screenshots.js [--filter <partial-name>]
 *
 * Requires the Atlas server to be running on BASE_URL (default localhost:3000).
 * Screenshots are saved to public/manual/images/.
 *
 * Each shot definition:
 *   name       — output filename (without .png)
 *   url        — page to open (relative to BASE_URL)
 *   waitFor    — CSS selector to wait for before capturing
 *   clip       — optional { x, y, width, height } to capture a sub-region
 *   viewport   — optional { width, height } override (default 1280×900)
 *   beforeShot — optional async (page) => {} for interactions before capture
 *   note       — human-readable description (not used by script)
 */

const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const BASE_URL = process.env.ATLAS_URL || 'http://localhost:3001';
const OUT_DIR = path.join(__dirname, '..', 'public', 'manual', 'images');
const TABLET_PORTRAIT = { width: 810, height: 1080 };
const DESKTOP = { width: 1280, height: 900 };

// ---------------------------------------------------------------------------
// Shot definitions
// ---------------------------------------------------------------------------

const SHOTS = [

  // --- People ---
  {
    name: 'people-list',
    note: 'Full people list with search bar and fencer rows',
    url: '/people.html',
    waitFor: '.person-row, #people-table, table tbody tr',
    viewport: DESKTOP,
  },

  // --- Clubs ---
  {
    name: 'clubs-list',
    note: 'Club management page',
    url: '/people.html',
    waitFor: 'body',
    viewport: DESKTOP,
    beforeShot: async page => {
      // click the Clubs tab if it exists
      const btn = await page.$('[data-tab="clubs"], button[onclick*="clubs"]');
      if (btn) { await btn.click(); await page.waitForTimeout(400); }
    },
  },

  // --- Tournaments ---
  {
    name: 'tournaments-list',
    note: 'Tournament list',
    url: '/tournaments.html',
    waitFor: 'body',
    viewport: DESKTOP,
  },

  // --- Competition detail ---
  {
    name: 'competition-detail',
    note: 'Competition detail page showing competitors list and phase controls',
    url: '/competition-detail.html',
    waitFor: 'body',
    viewport: DESKTOP,
    beforeShot: async page => {
      // Navigate to first available competition if the page needs an ID param
      const comps = await page.evaluate(async () => {
        const r = await fetch('/api/competitions');
        return r.ok ? r.json() : [];
      });
      if (comps.length) await page.goto(`${BASE_URL}/competition-detail.html?id=${comps[0].id}`);
      await page.waitForSelector('body');
      await page.waitForTimeout(600);
    },
  },

  // --- Pool formation form with options loaded ---
  {
    name: 'pool-formation',
    note: 'Competition detail page with pool options calculated and displayed',
    url: '/competition-detail.html',
    waitFor: 'body',
    viewport: DESKTOP,
    beforeShot: async page => {
      const comps = await page.evaluate(async () => {
        const r = await fetch('/api/competitions'); return r.ok ? r.json() : [];
      });
      if (!comps.length) return;
      await page.goto(`${BASE_URL}/competition-detail.html?id=${comps[0].id}`, { waitUntil: 'networkidle0' });
      await page.waitForTimeout(500);
      // Open the new phase form
      const newBtn = await page.$('button[\\@click*="phaseFormOpen"], button');
      const buttons = await page.$$('button');
      for (const btn of buttons) {
        const txt = await page.evaluate(el => el.textContent, btn);
        if (txt.includes('New')) { await btn.click(); break; }
      }
      await page.waitForTimeout(300);
      // Select first pool rule doc
      const ruleSelect = await page.$('select[x-model="newRuleDoc"]');
      if (ruleSelect) {
        const options = await page.$$eval('select[x-model="newRuleDoc"] option', os => os.map(o => o.value).filter(Boolean));
        if (options.length) await page.select('select[x-model="newRuleDoc"]', options[0]);
      }
      await page.waitForTimeout(200);
      // Click calculate
      const calcButtons = await page.$$('button');
      for (const btn of calcButtons) {
        const txt = await page.evaluate(el => el.textContent, btn);
        if (txt.includes('Calculate')) { await btn.click(); break; }
      }
      await page.waitForTimeout(600);
    },
  },

  // --- Phase overview ---
  {
    name: 'phase-overview',
    note: 'Phase page showing pool cards with strip/referee assignments',
    url: '/phase.html',
    waitFor: 'body',
    viewport: DESKTOP,
    beforeShot: async page => {
      const phases = await page.evaluate(async () => {
        const r = await fetch('/api/phases?type=pool');
        return r.ok ? r.json() : [];
      });
      if (phases.length) {
        await page.goto(`${BASE_URL}/phase.html?id=${phases[0].id}`);
        await page.waitForTimeout(600);
      }
    },
  },

  // --- Pool scoresheet ---
  {
    name: 'pool-matrix',
    note: 'Pool view showing FIE matrix + bout list',
    url: '/pool.html',
    waitFor: 'body',
    viewport: DESKTOP,
    beforeShot: async page => {
      const pools = await page.evaluate(async () => {
        const r = await fetch('/api/pools');
        return r.ok ? r.json() : [];
      });
      if (pools.length) {
        await page.goto(`${BASE_URL}/pool.html?id=${pools[0].id}`);
        await page.waitForTimeout(600);
      }
    },
  },

  // --- DE bracket ---
  {
    name: 'de-bracket',
    note: 'DE bracket view',
    url: '/de.html',
    waitFor: 'body',
    viewport: DESKTOP,
    beforeShot: async page => {
      const phases = await page.evaluate(async () => {
        const r = await fetch('/api/phases?type=de');
        return r.ok ? r.json() : [];
      });
      if (phases.length) {
        await page.goto(`${BASE_URL}/de.html?id=${phases[0].id}`);
        await page.waitForTimeout(600);
      }
    },
  },

  // --- Results ---
  {
    name: 'results',
    note: 'Final results page',
    url: '/results.html',
    waitFor: 'body',
    viewport: DESKTOP,
    beforeShot: async page => {
      const comps = await page.evaluate(async () => {
        const r = await fetch('/api/competitions');
        return r.ok ? r.json() : [];
      });
      if (comps.length) {
        await page.goto(`${BASE_URL}/results.html?id=${comps[0].id}`);
        await page.waitForTimeout(600);
      }
    },
  },

  // --- Strips ---
  {
    name: 'strips',
    note: 'Strip management page',
    url: '/strips.html',
    waitFor: 'body',
    viewport: DESKTOP,
  },

  // --- OPP2 admin ---
  {
    name: 'opp2-admin',
    note: 'OPP2 broker config and pipeline builder',
    url: '/opp2.html',
    waitFor: 'body',
    viewport: DESKTOP,
  },

  // --- Scoresheet (tablet portrait, dark) ---
  {
    name: 'scoresheet-dark',
    note: 'Scoresheet in dark mode on tablet portrait',
    url: '/scoresheet.html',
    waitFor: 'body',
    viewport: TABLET_PORTRAIT,
  },

  // --- Scoresheet (tablet portrait, light) ---
  {
    name: 'scoresheet-light',
    note: 'Scoresheet in light mode on tablet portrait',
    url: '/scoresheet.html',
    waitFor: 'body',
    viewport: TABLET_PORTRAIT,
    beforeShot: async page => {
      // Switch to light theme via localStorage
      await page.evaluate(() => localStorage.setItem('scoresheet-theme', 'light'));
      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForTimeout(300);
    },
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function run() {
  const filterArg = process.argv.indexOf('--filter');
  const filter = filterArg !== -1 ? process.argv[filterArg + 1] : null;

  const shots = filter ? SHOTS.filter(s => s.name.includes(filter)) : SHOTS;
  if (!shots.length) { console.error('No shots matched filter:', filter); process.exit(1); }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });

  let ok = 0, fail = 0;
  for (const shot of shots) {
    const vp = shot.viewport || DESKTOP;
    const page = await browser.newPage();
    await page.setViewport(vp);
    try {
      await page.goto(`${BASE_URL}${shot.url}`, { waitUntil: 'networkidle0', timeout: 15000 });
      if (shot.waitFor) await page.waitForSelector(shot.waitFor, { timeout: 8000 }).catch(() => {});
      if (shot.beforeShot) await shot.beforeShot(page);
      const outPath = path.join(OUT_DIR, shot.name + '.png');
      const opts = { path: outPath, ...(shot.clip ? { clip: shot.clip } : { fullPage: false }) };
      await page.screenshot(opts);
      console.log(`  ✓  ${shot.name}.png`);
      ok++;
    } catch (err) {
      console.error(`  ✗  ${shot.name}: ${err.message}`);
      fail++;
    }
    await page.close();
  }

  await browser.close();
  console.log(`\nDone: ${ok} ok, ${fail} failed. Output → ${OUT_DIR}`);
  if (fail) process.exit(1);
}

run().catch(err => { console.error(err); process.exit(1); });
