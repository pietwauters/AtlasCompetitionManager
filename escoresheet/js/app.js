'use strict';

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function updateInstalledStatus() {
  const standalone = window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
  setText('status-installed', standalone ? 'Installed (standalone)' : 'Running in browser tab');
}

function updateOnlineStatus() {
  setText('status-online', navigator.onLine ? 'Online' : 'Offline');
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    setText('status-sw', 'Not supported by this browser');
    return;
  }
  try {
    const reg = await navigator.serviceWorker.register('service-worker.js');
    setText('status-sw', reg.active ? 'Active' : 'Registered, installing…');
    reg.addEventListener('updatefound', () => setText('status-sw', 'Updating…'));
  } catch (err) {
    setText('status-sw', `Registration failed: ${err.message}`);
  }
}

function renderPairedState() {
  const label = localStorage.getItem('escoresheet.deviceLabel');
  const username = localStorage.getItem('escoresheet.mqttUsername');
  const paired = !!username;
  document.getElementById('pair-card').hidden = paired;
  document.getElementById('paired-card').hidden = !paired;
  setText('status-pairing', paired ? `Paired (${label || username})` : 'not paired');
  if (paired) setText('paired-label', label || username);
}

// Stores a credential directly — no network round-trip to Atlas (per
// docs/security-provisioning-discussion.md §4.5, assignment already happened on the
// operator's side; this device only needs to learn the result).
function applyPairing(username, password, label) {
  if (!username || !password) return false;
  localStorage.setItem('escoresheet.mqttUsername', username);
  localStorage.setItem('escoresheet.mqttPassword', password);
  if (label) localStorage.setItem('escoresheet.deviceLabel', label);
  renderPairedState();
  return true;
}

function initPairingUI() {
  // The pairing QR encodes the credential in the URL *fragment*
  // (#u=...&p=...&l=...), not the query string, so it never reaches Atlas's own
  // server (fragments are client-side only) and doesn't land in any access log.
  // Scrub it from the visible URL/history immediately after reading it.
  //
  // Deliberately pre-fill rather than auto-apply: a standalone iOS home-screen
  // install runs in a storage container isolated from Safari's own tabs, so
  // anything written straight to localStorage here never reaches the installed
  // app. A real <form> submit — an actual user gesture, not JS calling
  // localStorage directly — is what makes Safari offer to save the credential
  // to iCloud Keychain, which (unlike localStorage) *is* shared with the
  // installed app. That's why the field values only get applied from the
  // form's submit handler below, never here directly.
  let label = null;
  if (location.hash.length > 1) {
    const frag = new URLSearchParams(location.hash.slice(1));
    document.getElementById('pair-username').value = frag.get('u') || '';
    document.getElementById('pair-password').value = frag.get('p') || '';
    label = frag.get('l');
    history.replaceState(null, '', location.pathname + location.search);
  }

  document.getElementById('pair-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const errorEl = document.getElementById('pair-error');
    errorEl.hidden = true;
    const username = document.getElementById('pair-username').value.trim();
    const password = document.getElementById('pair-password').value.trim();
    if (!applyPairing(username, password, label)) {
      errorEl.textContent = 'Enter both the MQTT username and password.';
      errorEl.hidden = false;
    }
  });

  document.getElementById('forget-button').addEventListener('click', () => {
    localStorage.removeItem('escoresheet.deviceLabel');
    localStorage.removeItem('escoresheet.mqttUsername');
    localStorage.removeItem('escoresheet.mqttPassword');
    renderPairedState();
  });

  renderPairedState();
}

// ── Live piste watching (MQTT over WSS) ────────────────────────────────────
// Read-only display: subscribes to whatever the apparatus/CMS already
// publish and mirrors it. Never publishes anything — this is purely the
// "display" role from docs/roles-and-responsibilities-discussion.md §2.3.

let mqttClient = null;
let currentPiste = null;
let pubSeq = 0;

// Card-reason state — the one part of this app that publishes rather than
// just displays (docs/level2.md §18/§22). Everything else stays read-only.
let reasonDefs = null;
let currentWeapon = 'F';
let slotId = null;
let activeBoutId = null;
let officials = {};        // { referee, referee2, assessor1, assessor2 }
let annotations = [];      // flat list for the current slot
let lastScoreForCards = null;
let lastFencers = null;    // last apparatus/fencers payload, for the active bout row
let lastClock = null;      // last apparatus/clock payload, re-applied after bout-list re-renders
let dialog = null;         // { side, card, step, fencerName, officialId, custom }
let hasConnectedOnce = false; // false until the first successful connect for the current piste

// Full-slot state — pool matrix, bout list, team relay banner (docs/level2.md §16/§17).
let participants = [];
let bouts = [];            // [{ id, order, left, right, result, expanded }]
let phaseType = null;
let slotLabel = '';
let matchInfo = null;

async function loadReasonDefs() {
  if (reasonDefs) return reasonDefs;
  try {
    const all = await fetch('/data/reasons.json').then((r) => r.json());
    reasonDefs = all.en || null;
  } catch {
    reasonDefs = null;
  }
  return reasonDefs;
}

function cardChips(side) {
  const chips = [];
  for (let i = 0; i < (side.red_cards || 0); i++) chips.push('<span class="card-chip red"></span>');
  if (side.yellow_card) chips.push('<span class="card-chip yellow"></span>');
  if (side.black_card) chips.push('<span class="card-chip black"></span>');
  return chips.join('');
}

function renderScore(payload) {
  setText('left-score', payload.left?.score ?? 0);
  setText('right-score', payload.right?.score ?? 0);
  const leftCards = document.getElementById('left-cards');
  const rightCards = document.getElementById('right-cards');
  if (leftCards) leftCards.innerHTML = cardChips(payload.left || {});
  if (rightCards) rightCards.innerHTML = cardChips(payload.right || {});
  const priority = { L: 'Priority: left', R: 'Priority: right', N: '' }[payload.priority] || '';
  setText('priority-indicator', priority);
}

function renderFencers(payload) {
  lastFencers = payload;
  const empty = !payload.left?.fencer?.id && !payload.right?.fencer?.id;
  if (!empty) {
    setText('left-name', payload.left?.fencer?.name || '—');
    setText('right-name', payload.right?.fencer?.name || '—');
  }
}

function renderClock(payload) {
  lastClock = payload;
  setText('clock-time', payload.time || '0:00');
}

// Apparatus state, from the retained apparatus/connection message — never touched
// by this e-scoresheet's own broker connectivity (see renderBrokerStatus below).
// Conflating the two used to mean "apparatus offline" could also just mean this
// phone lost WiFi, with no way to tell which from the badge alone.
function renderConnection(online) {
  const badge = document.getElementById('conn-badge');
  badge.textContent = online ? 'apparatus online' : 'apparatus offline';
  badge.className = 'badge ' + (online ? 'online' : 'offline');
}

// This e-scoresheet's own connection to the broker — independent of apparatus state.
function renderBrokerStatus(state) {
  const badge = document.getElementById('broker-badge');
  if (!badge) return;
  const label = { connecting: 'connecting…', connected: 'live', reconnecting: 'reconnecting…', disconnected: 'disconnected' }[state] || state;
  const cls = { connected: 'online', reconnecting: 'reconnecting', disconnected: 'offline' }[state] || '';
  badge.textContent = label;
  badge.className = 'badge ' + cls;
}

function renderMatch(payload) {
  currentWeapon = payload.weapon || currentWeapon;
  matchInfo = payload;
  const weaponName = { F: 'Foil', E: 'Épée', S: 'Sabre' }[payload.weapon] || payload.weapon;
  const parts = [weaponName, payload.phase_type, payload.poule, payload.match ? `Match ${payload.match}` : null]
    .filter(Boolean);
  setText('match-info', parts.join(' · '));
  renderTeamRelayBanner();
}

function renderTeamRelayBanner() {
  const el = document.getElementById('team-relay-banner');
  if (matchInfo?.type !== 'T') { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `
    <span class="relay-label">Team relay ${matchInfo.relay || ''} / ${matchInfo.relay_total || 9}</span>
    <span>${matchInfo.left_team || ''}</span>
    <span class="relay-score">${matchInfo.left_cumul ?? '—'} &ndash; ${matchInfo.right_cumul ?? '—'}</span>
    <span>${matchInfo.right_team || ''}</span>
    <span class="relay-target">target ${matchInfo.target || ''}</span>
  `;
}

function fencerNameForDialog(side) {
  const el = document.getElementById(side === 'left' ? 'left-name' : 'right-name');
  return (el && el.textContent) || (side === 'left' ? 'Left fencer' : 'Right fencer');
}

function boutFencerName(f) {
  if (!f) return 'TBD';
  return f.name || 'TBD';
}

// ── Card detection and reason recording ────────────────────────────────────

function detectCards(prev, next) {
  for (const side of ['left', 'right']) {
    const p = prev?.[side] || {};
    const n = next?.[side] || {};
    if (!p.yellow_card && n.yellow_card) triggerDialog(side, 'yellow');
    if ((n.red_cards || 0) > (p.red_cards || 0)) triggerDialog(side, 'red');
    if (!p.black_card && n.black_card) triggerDialog(side, 'black');
  }
}

function checkDialogCancelled(score) {
  if (!dialog) return;
  const s = score?.[dialog.side] || {};
  const gone = (dialog.card === 'yellow' && !s.yellow_card)
    || (dialog.card === 'red' && !(s.red_cards > 0))
    || (dialog.card === 'black' && !s.black_card);
  if (gone) closeDialog();
}

function cardOfficials() {
  const list = [];
  if (officials.referee) list.push({ ...officials.referee, role: 'referee' });
  if (officials.referee2) list.push({ ...officials.referee2, role: 'referee2' });
  if (officials.assessor1) list.push({ ...officials.assessor1, role: 'assessor1' });
  if (officials.assessor2) list.push({ ...officials.assessor2, role: 'assessor2' });
  return list;
}

function roleLabel(role) {
  return { referee: 'Referee', referee2: 'Referee 2', assessor1: 'Assessor 1', assessor2: 'Assessor 2' }[role] || role;
}

function reasonsFor(card, step) {
  if (!reasonDefs) return [];
  if (step === 2) {
    return (reasonDefs.yellow || [])
      .filter((r) => !r.weapons || r.weapons.includes(currentWeapon))
      .map((r) => ({ text: r.text, drilldown: false }));
  }
  return (reasonDefs[card] || [])
    .filter((r) => !r.weapons || r.weapons.includes(currentWeapon))
    .map((r) => ({ text: r.text, drilldown: r.drilldown || false }));
}

function triggerDialog(side, card) {
  const officialList = cardOfficials();
  dialog = {
    side, card, step: 1, custom: '',
    fencerName: fencerNameForDialog(side),
    officialId: officialList[0]?.id ?? null,
  };
  renderDialog();
  document.getElementById('reason-overlay').hidden = false;
}

function closeDialog() {
  dialog = null;
  document.getElementById('reason-overlay').hidden = true;
}

function renderDialog() {
  if (!dialog) return;
  const badge = document.getElementById('dialog-card-badge');
  badge.className = 'card-badge ' + dialog.card;
  badge.textContent = dialog.card.charAt(0).toUpperCase() + dialog.card.slice(1) + ' card';
  setText('dialog-side-label', dialog.step === 2 ? 'Which Group 1 offence?' : (dialog.side === 'left' ? '← Left' : 'Right →'));
  setText('dialog-fencer-name', dialog.fencerName);
  document.getElementById('dialog-back').hidden = dialog.step !== 2;

  const officialList = cardOfficials();
  const picker = document.getElementById('official-picker');
  picker.hidden = officialList.length <= 1;
  const chips = document.getElementById('official-chips');
  chips.innerHTML = '';
  for (const o of officialList) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'official-chip' + (dialog.officialId === o.id ? ' selected' : '');
    chip.textContent = `${o.name} (${roleLabel(o.role)})`;
    chip.addEventListener('click', () => { dialog.officialId = o.id; renderDialog(); });
    chips.appendChild(chip);
  }

  const grid = document.getElementById('reason-grid');
  grid.innerHTML = '';
  for (const r of reasonsFor(dialog.card, dialog.step)) {
    const btn = document.createElement('button');
    btn.className = 'reason-btn' + (r.drilldown ? ' drilldown' : '');
    btn.textContent = r.drilldown ? r.text + ' ▸' : r.text;
    btn.addEventListener('click', () => {
      if (r.drilldown) { dialog.step = 2; renderDialog(); }
      else submitReason(r.text);
    });
    grid.appendChild(btn);
  }

  document.getElementById('reason-custom').value = dialog.custom;
}

function selectedOfficial() {
  const o = cardOfficials().find((o) => o.id === dialog.officialId);
  return o ? { id: o.id, name: o.name, role: o.role } : null;
}

function submitReason(reasonText) {
  if (!reasonText?.trim() || !dialog) return;
  const { side, card, step } = dialog;
  const prefix = reasonDefs?.strings?.repeated_group1_prefix ?? 'Repeated Group 1: ';
  const reason = step === 2 ? prefix + reasonText.trim() : reasonText.trim();
  const official = selectedOfficial();

  publishCardReason(side, card, reason, official);
  annotations = [{ bout_id: activeBoutId || null, event: 'CARD_REASON', side, card, reason, ts: Date.now(), official }, ...annotations];
  publishAnnotationRecord();
  renderBoutList();
  closeDialog();
}

function annotationsHtml(boutId) {
  const list = annotations.filter((a) => a.bout_id === boutId);
  if (!list.length) return '';
  return `<div class="annotations">${list.map((a) => `
    <div class="annotation-row">
      <span class="card-chip ${a.card}"></span>
      <span class="annotation-side">${a.side}</span>
      <span class="annotation-reason">${a.reason}${a.official ? ` — ${a.official.name}` : ''}</span>
      <span class="annotation-time">${new Date(a.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
    </div>
  `).join('')}</div>`;
}

function publishCardReason(side, card, reason, official) {
  if (!mqttClient || !currentPiste) return;
  const payload = {
    protocol: 'OPP2', version: '1.0', seq: ++pubSeq, ts: Date.now(),
    event: 'CARD_REASON', bout_id: activeBoutId || undefined, side, card, reason,
    ...(official ? { official } : {}),
  };
  mqttClient.publish(`openpiste/${currentPiste}/scoresheet/event`, JSON.stringify(payload), { qos: 1 });
}

// docs/level2.md §17/§24 — slot-level navigation, distinct from the apparatus's
// own bout-level NEXT/PREV. The CMS silently ignores these when the guard
// conditions aren't met (current slot still has unconfirmed bouts, or already
// has confirmed results) — no error surfaces here, the retained software/record
// simply won't change if the request was rejected.
function publishSlotControl(command) {
  if (!mqttClient || !currentPiste) return;
  const payload = { protocol: 'OPP2', version: '1.0', seq: ++pubSeq, ts: Date.now(), command };
  mqttClient.publish(`openpiste/${currentPiste}/scoresheet/control`, JSON.stringify(payload), { qos: 1 });
}

function publishAnnotationRecord() {
  if (!mqttClient || !currentPiste || !slotId) return;
  const payload = {
    protocol: 'OPP2', version: '1.0', seq: ++pubSeq, slot_id: slotId,
    annotations: annotations.map((a) => ({
      bout_id: a.bout_id, event: a.event, side: a.side, card: a.card, reason: a.reason, ts: a.ts,
      ...(a.official ? { official: a.official } : {}),
    })),
  };
  mqttClient.publish(`openpiste/${currentPiste}/scoresheet/record`, JSON.stringify(payload), { qos: 1, retain: true });
}

// ── Slot/record tracking (docs/level2.md §17/§18) ──────────────────────────

function handleSoftwareRecord(payload) {
  const newSlotId = payload.slot_id;
  if (!newSlotId) return;
  const prevActive = activeBoutId;
  const slotChanged = newSlotId !== slotId;

  officials = {
    referee: payload.referee || null,
    referee2: payload.referee2 || null,
    assessor1: payload.assessor1 || null,
    assessor2: payload.assessor2 || null,
  };

  if (slotChanged) {
    slotId = newSlotId;
    phaseType = payload.phase_type || null;
    slotLabel = payload.label || '';
    participants = payload.participants || [];
    activeBoutId = payload.active_bout || null;
    bouts = (payload.bouts || []).map((b, i) => ({
      id: b.id, order: b.order || i + 1, left: b.left || null, right: b.right || null,
      result: b.result || null, expanded: b.id === activeBoutId,
    }));
    annotations = [];
    lastScoreForCards = null; lastFencers = null; lastClock = null;
    publishAnnotationRecord();
  } else {
    activeBoutId = payload.active_bout || null;
    slotLabel = payload.label || slotLabel;
    if (payload.participants?.length) participants = payload.participants;
    for (const b of bouts) {
      const pb = (payload.bouts || []).find((x) => x.id === b.id);
      if (!pb) continue;
      if (pb.left) b.left = pb.left;
      if (pb.right) b.right = pb.right;
      b.result = pb.result || null;
      if (b.id === activeBoutId && !b.expanded) b.expanded = true;
      if (b.id !== activeBoutId && b.expanded && activeBoutId !== prevActive) b.expanded = false;
    }
    if (activeBoutId !== prevActive) { lastScoreForCards = null; lastFencers = null; lastClock = null; }
  }

  renderSlotInfo();
  renderMatrix();
  renderBoutList();
}

function renderSlotInfo() {
  const names = [officials.referee, officials.referee2, officials.assessor1, officials.assessor2]
    .filter(Boolean).map((o) => o.name);
  const parts = [slotLabel, names.length ? `Officials: ${names.join(', ')}` : null].filter(Boolean);
  setText('slot-info', parts.join(' · '));
}

function handleScoresheetRecord(payload) {
  if (!payload.slot_id || payload.slot_id !== slotId) return;
  annotations = payload.annotations || [];
  renderBoutList();
}

// ── Pool matrix (docs/level2.md §17 participants; same ranking algorithm as
// public/scoresheet.html's matrix getter) ──────────────────────────────────

function computeMatrix() {
  if (phaseType !== 'pool' || !participants.length) return null;
  const n = participants.length;
  const idxOf = {};
  participants.forEach((p, i) => { idxOf[p.id] = i; });
  const grid = Array.from({ length: n }, () => Array(n).fill(null));
  const stats = Array.from({ length: n }, () => ({ v: 0, ts: 0, tr: 0, m: 0 }));
  for (const bout of bouts) {
    if (!bout.result || !bout.left || !bout.right) continue;
    const li = idxOf[bout.left.id];
    const ri = idxOf[bout.right.id];
    if (li === undefined || ri === undefined) continue;
    const { left_score: ls, right_score: rs } = bout.result;
    const lWon = ls > rs;
    grid[li][ri] = { score: ls, won: lWon };
    grid[ri][li] = { score: rs, won: !lWon };
    stats[li].ts += ls; stats[li].tr += rs; stats[li].m++; if (lWon) stats[li].v++;
    stats[ri].ts += rs; stats[ri].tr += ls; stats[ri].m++; if (!lWon) stats[ri].v++;
  }
  const order = [...Array(n).keys()];
  order.sort((a, b) => {
    if (!stats[a].m) return 1;
    if (!stats[b].m) return -1;
    const vmA = stats[a].v / stats[a].m, vmB = stats[b].v / stats[b].m;
    if (vmA !== vmB) return vmB - vmA;
    const iA = stats[a].ts - stats[a].tr, iB = stats[b].ts - stats[b].tr;
    if (iA !== iB) return iB - iA;
    return stats[b].ts - stats[a].ts;
  });
  const rankOf = {};
  order.forEach((idx, pos) => { rankOf[idx] = pos + 1; });
  return { participants, grid, stats, rankOf };
}

function renderMatrix() {
  const section = document.getElementById('matrix-section');
  const matrix = computeMatrix();
  if (!matrix) { section.hidden = true; return; }
  section.hidden = false;

  const wrap = document.getElementById('matrix-wrap');
  const { participants: ps, grid, stats, rankOf } = matrix;
  let html = '<table class="mtx"><thead><tr><th>#</th><th class="td-name">Name</th>';
  ps.forEach((_, j) => { html += `<th>${j + 1}</th>`; });
  html += '<th>V/M</th><th>Ind</th><th>TS</th><th>TR</th><th class="td-rank">Rank</th></tr></thead><tbody>';
  ps.forEach((p, i) => {
    html += `<tr><td>${i + 1}</td><td class="td-name">${boutFencerName(p)}</td>`;
    ps.forEach((_, j) => {
      if (i === j) { html += '<td class="td-diag"></td>'; return; }
      const d = grid[i][j];
      if (!d) { html += '<td class="td-empty"></td>'; return; }
      html += `<td class="${d.won ? 'td-won' : 'td-lost'}">${d.won ? 'V' + d.score : d.score}</td>`;
    });
    const s = stats[i];
    const vm = s.m > 0 ? (s.v / s.m).toFixed(2) : '—';
    const ind = s.ts - s.tr;
    html += `<td>${vm}</td><td>${ind > 0 ? '+' + ind : ind}</td><td>${s.m ? s.ts : ''}</td><td>${s.m ? s.tr : ''}</td>`;
    html += `<td class="td-rank">${s.m ? (rankOf[i] ?? '—') : '—'}</td></tr>`;
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;
}

// ── Bout list ────────────────────────────────────────────────────────────

function boutHeaderScore(bout) {
  if (bout.result) return `${bout.result.left_score} : ${bout.result.right_score}`;
  if (bout.id === activeBoutId && lastScoreForCards) return `${lastScoreForCards.left?.score ?? '—'} : ${lastScoreForCards.right?.score ?? '—'}`;
  return '— : —';
}

function liveScoreboardHtml() {
  const s = lastScoreForCards;
  const leftName = lastFencers?.left?.fencer?.id ? lastFencers.left.fencer.name : null;
  const rightName = lastFencers?.right?.fencer?.id ? lastFencers.right.fencer.name : null;
  return `
    <div class="scoreboard">
      <div class="fencer">
        <div class="fencer-name" id="left-name">${leftName || '—'}</div>
        <div class="fencer-score" id="left-score">${s?.left?.score ?? 0}</div>
        <div class="fencer-cards" id="left-cards">${cardChips(s?.left || {})}</div>
      </div>
      <div class="clock-box">
        <div class="clock" id="clock-time">${lastClock?.time || '0:00'}</div>
        <div class="priority" id="priority-indicator"></div>
      </div>
      <div class="fencer">
        <div class="fencer-name" id="right-name">${rightName || '—'}</div>
        <div class="fencer-score" id="right-score">${s?.right?.score ?? 0}</div>
        <div class="fencer-cards" id="right-cards">${cardChips(s?.right || {})}</div>
      </div>
    </div>
  `;
}

function renderBoutList() {
  const listEl = document.getElementById('bout-list');
  const emptyMsg = document.getElementById('no-bouts-msg');
  if (!bouts.length) {
    listEl.innerHTML = '';
    emptyMsg.hidden = false;
    return;
  }
  emptyMsg.hidden = true;

  listEl.innerHTML = bouts.map((bout) => {
    const isLive = bout.id === activeBoutId && !bout.result;
    const header = `
      <div class="bout-header ${bout.result ? 'bout-finished' : ''}" data-bout-id="${bout.id}">
        <span class="bout-order">${bout.order || ''}</span>
        <span class="bout-fname">${boutFencerName(bout.left)}</span>
        <span class="bout-inline-score ${isLive ? 'live' : ''} ${bout.result ? 'finished' : ''}">${boutHeaderScore(bout)}</span>
        <span class="bout-fname right">${boutFencerName(bout.right)}</span>
        ${isLive ? '<span class="live-badge">LIVE</span>' : ''}
        <span class="toggle-arrow ${bout.expanded ? 'open' : ''}">&#9656;</span>
      </div>
    `;
    const body = bout.expanded ? `
      <div class="bout-body">
        ${isLive ? liveScoreboardHtml() : ''}
        ${annotationsHtml(bout.id)}
      </div>
    ` : '';
    return `<div class="bout-item ${isLive ? 'live-item' : ''}">${header}${body}</div>`;
  }).join('');

  // Re-apply the live topic values now that the DOM nodes exist again.
  if (lastScoreForCards) renderScore(lastScoreForCards);
}

function toggleBout(id) {
  const b = bouts.find((b) => b.id === id);
  if (b) { b.expanded = !b.expanded; renderBoutList(); }
}

function watchPiste(piste) {
  if (mqttClient) { mqttClient.end(true); mqttClient = null; }

  currentPiste = piste;
  localStorage.setItem('escoresheet.piste', piste);
  document.getElementById('watch-error').hidden = true;
  document.getElementById('paired-card').hidden = true;
  document.getElementById('live-card').hidden = false;
  setText('live-piste-label', piste);
  renderConnection(false);
  renderBrokerStatus('connecting');
  hasConnectedOnce = false;

  slotId = null; activeBoutId = null; officials = {}; annotations = [];
  lastScoreForCards = null; lastFencers = null; lastClock = null;
  participants = []; bouts = []; phaseType = null; slotLabel = ''; matchInfo = null;
  renderSlotInfo();
  renderMatrix();
  renderBoutList();
  document.getElementById('team-relay-banner').hidden = true;
  setText('match-info', '');
  loadReasonDefs();

  const url = `wss://${location.hostname}:9002`;
  const topicPrefix = `openpiste/${piste}`;
  const mqttUsername = localStorage.getItem('escoresheet.mqttUsername');
  const mqttPassword = localStorage.getItem('escoresheet.mqttPassword');
  mqttClient = mqtt.connect(url, {
    reconnectPeriod: 2000,
    ...(mqttUsername ? { username: mqttUsername, password: mqttPassword } : {}),
  });

  mqttClient.on('connect', () => {
    if (hasConnectedOnce) {
      // Reconnecting after a drop, not the first connect for this piste. The
      // retained snapshot we're about to receive again reflects only the
      // *current* state — if more than one card/touch happened while we were
      // disconnected, diffing it against what we last saw before the drop could
      // misattribute or undercount what actually happened (e.g. two red cards
      // collapsed into one). Resync silently instead of risking a false or
      // incomplete card-reason trigger — same reasoning as skipping detection
      // on the very first message ever (lastScoreForCards starts null).
      lastScoreForCards = null;
      lastFencers = null;
      lastClock = null;
    }
    hasConnectedOnce = true;
    renderBrokerStatus('connected');
    mqttClient.subscribe(`${topicPrefix}/apparatus/connection`);
    mqttClient.subscribe(`${topicPrefix}/apparatus/fencers`);
    mqttClient.subscribe(`${topicPrefix}/apparatus/score`);
    mqttClient.subscribe(`${topicPrefix}/apparatus/clock`);
    mqttClient.subscribe(`${topicPrefix}/software/match`);
    mqttClient.subscribe(`${topicPrefix}/software/record`);
    mqttClient.subscribe(`${topicPrefix}/scoresheet/record`);
  });

  mqttClient.on('message', (topic, message) => {
    let payload;
    try { payload = JSON.parse(message.toString()); } catch { return; }
    const type = topic.slice(topicPrefix.length + 1);
    if (type === 'apparatus/connection') renderConnection(!!payload.online);
    else if (type === 'apparatus/fencers') renderFencers(payload);
    else if (type === 'apparatus/score') {
      if (lastScoreForCards) detectCards(lastScoreForCards, payload);
      lastScoreForCards = payload;
      renderScore(payload);
      checkDialogCancelled(payload);
    }
    else if (type === 'apparatus/clock') renderClock(payload);
    else if (type === 'software/match') renderMatch(payload);
    else if (type === 'software/record') handleSoftwareRecord(payload);
    else if (type === 'scoresheet/record') handleScoresheetRecord(payload);
  });

  mqttClient.on('reconnect', () => renderBrokerStatus('reconnecting'));
  mqttClient.on('close', () => renderBrokerStatus('disconnected'));
  mqttClient.on('offline', () => renderBrokerStatus('disconnected'));
  // 'error' precedes 'close' in practice — avoid a duplicate/flickery state change.
  mqttClient.on('error', (err) => console.error('[escoresheet] MQTT error:', err.message));
}

function stopWatching() {
  if (mqttClient) { mqttClient.end(true); mqttClient = null; }
  currentPiste = null;
  document.getElementById('live-card').hidden = true;
  document.getElementById('paired-card').hidden = false;
}

function initReasonDialogUI() {
  document.getElementById('dialog-back').addEventListener('click', () => { dialog.step = 1; renderDialog(); });
  document.getElementById('reason-skip').addEventListener('click', closeDialog);
  document.getElementById('reason-custom').addEventListener('input', (e) => { if (dialog) dialog.custom = e.target.value; });
  document.getElementById('reason-custom').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && dialog?.custom.trim()) submitReason(dialog.custom.trim());
  });
  document.getElementById('reason-submit').addEventListener('click', () => {
    if (dialog?.custom.trim()) submitReason(dialog.custom.trim());
  });
}

function initLiveUI() {
  const lastPiste = localStorage.getItem('escoresheet.piste');
  if (lastPiste) document.getElementById('piste-input').value = lastPiste;

  document.getElementById('watch-button').addEventListener('click', () => {
    const piste = document.getElementById('piste-input').value.trim();
    const errorEl = document.getElementById('watch-error');
    if (!piste) {
      errorEl.textContent = 'Enter a piste id first.';
      errorEl.hidden = false;
      return;
    }
    watchPiste(piste);
  });

  document.getElementById('change-piste-button').addEventListener('click', stopWatching);

  document.getElementById('next-slot-button').addEventListener('click', () => publishSlotControl('NEXT_SLOT'));
  document.getElementById('prev-slot-button').addEventListener('click', () => publishSlotControl('PREV_SLOT'));

  document.getElementById('bout-list').addEventListener('click', (e) => {
    const header = e.target.closest('.bout-header');
    if (header) toggleBout(Number(header.dataset.boutId));
  });

  document.getElementById('matrix-toggle').addEventListener('click', () => {
    const wrap = document.getElementById('matrix-wrap');
    const arrow = document.getElementById('matrix-arrow');
    wrap.hidden = !wrap.hidden;
    arrow.classList.toggle('open', !wrap.hidden);
  });
}

function initTheme() {
  const saved = localStorage.getItem('escoresheet.theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);

  document.getElementById('theme-toggle')?.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme')
      || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('escoresheet.theme', next);
  });
}

window.addEventListener('online', updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);

initTheme();
updateInstalledStatus();
updateOnlineStatus();
registerServiceWorker();
initPairingUI();
initLiveUI();
initReasonDialogUI();
