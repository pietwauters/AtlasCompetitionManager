'use strict';

// Pure(-ish — reads cached rule files, no DB) per-stage math for the tournament
// schedule planner. Reuses the exact same pool/DE sizing functions the live
// system uses for real competitors (lib/poolFormation.js's calcPoolOptions,
// lib/deFormation.js's getTableauSize), just fed an estimated N instead of a
// real competitor count. See docs/format-authoring-guide.md for rule file
// fields (poolFormation, advancement, placement).

const { loadRule }        = require('../lib/rules');
const { calcPoolOptions } = require('../lib/poolFormation');
const { getTableauSize }  = require('../lib/deFormation');
const BoutDurationStandards = require('./boutDurationStandards');

const DEFAULT_POOL_RULE = 'pool-standard.json';
const DEFAULT_DE_RULE   = 'de-standard.json';
const FALLBACK_MINUTES  = 5;

// competitions.weapon stores the full word ('foil'/'epee'/'sabre');
// bout_duration_standards keys on the single-letter code instead (same
// mapping services/pipelineSlots.js's SQL CASE already does elsewhere) —
// without this, getEffective() never matches a row and every stage silently
// falls back to FALLBACK_MINUTES regardless of weapon or phase, which is
// wildly wrong for DE (configured 15-25 min/bout vs a 5 min fallback).
const WEAPON_CODE = { foil: 'F', epee: 'E', sabre: 'S' };

function combinations2(n) {
  return (n * (n - 1)) / 2;
}

// Same recommended-option pick as services/poolPhases.js's calcOptions:
// first uniform (equal-size) split if one exists, else the first option.
function pickRecommendedPoolSizes(N, ruleDoc) {
  const rule = loadRule(ruleDoc);
  const options = calcPoolOptions(N, rule.poolFormation);
  const recIdx = options.findIndex(o => o.every(s => s === o[0]));
  return options[recIdx >= 0 ? recIdx : 0];
}

// Given an estimated N, projects the pool split, bout count, and total
// piste-minutes needed to run every pool once. "Total" here means the sum
// across all pools — the solver divides this by however many pistes are
// actually assigned to the stage to get wall-clock duration (see
// services/schedulePlanSolver.js) rather than this function assuming a
// piste count itself.
function computePoolStage(N, ruleDoc, weapon, gender) {
  const poolSizes = pickRecommendedPoolSizes(N, ruleDoc);
  const boutCount = poolSizes.reduce((sum, size) => sum + combinations2(size), 0);
  const minutesPerBout = BoutDurationStandards.getEffective(weapon, gender, 'pool') || FALLBACK_MINUTES;
  return {
    poolSizes,
    poolCount: poolSizes.length,
    boutCount,
    minutesPerBout,
    totalBoutMinutes: boutCount * minutesPerBout,
    suggestedPistes: poolSizes.length,
  };
}

// Bout count per DE round, largest first: a T=32 tableau is [16, 8, 4, 2, 1]
// (round of 32 down to the final). A tableau genuinely tapers — round 1
// needs up to T/2 pistes running at once, the final only ever needs one —
// unlike a pool round, where every pool's bouts are independent of every
// other pool's from the start. A third-place bout (if the rule enables one)
// is folded into the final's own round rather than added as a separate
// round: it's fenced alongside the final, not sequentially after it, and at
// that bout count (1 or 2) the timing difference is negligible for an estimate.
function deRoundBoutCounts(tableau, thirdPlaceBout) {
  const rounds = [];
  for (let bouts = tableau / 2; bouts >= 1; bouts /= 2) rounds.push(bouts);
  if (thirdPlaceBout) rounds[rounds.length - 1] += 1;
  return rounds;
}

// Given an estimated N, projects the DE tableau size, its round-by-round
// bout counts (see deRoundBoutCounts), and total bout count/duration.
// Known Phase-1 simplification (see the schedule-planner plan doc): assumes
// straight single-elimination round structure — repechage/all-places-fenced
// rule docs need a richer round/bracket structure for full accuracy. This
// only affects estimate precision, not the tool's shape, so it's a
// documented follow-up rather than a blocker.
function computeDeStage(N, ruleDoc, weapon, gender) {
  const rule = loadRule(ruleDoc);
  const tableau = getTableauSize(Math.max(N, 2));
  const roundBoutCounts = deRoundBoutCounts(tableau, rule.placement?.thirdPlaceBout);
  const boutCount = roundBoutCounts.reduce((sum, n) => sum + n, 0);
  const minutesPerBout = BoutDurationStandards.getEffective(weapon, gender, 'de') || FALLBACK_MINUTES;
  return {
    tableau,
    roundBoutCounts,
    boutCount,
    minutesPerBout,
    totalBoutMinutes: boutCount * minutesPerBout,
    // Round 1 is the busiest round — sizing to it lets round 1 run at full
    // parallelism, with later rounds naturally using fewer pistes (clamped
    // per-round by services/schedulePlans.js's solver-unit builder) rather
    // than idling extra pistes that a flatter number would imply.
    suggestedPistes: roundBoutCounts[0],
  };
}

// N projected through a %-advancement pool stage — same formula
// services/formats.js's validateCounts already applies for its own
// feasibility check (Math.round(N * pct / 100)), reused rather than
// re-derived so the two never drift apart.
function projectAdvancement(N, ruleDoc) {
  const rule = loadRule(ruleDoc);
  const pct = (rule.advancement?.value ?? 100) / 100;
  return Math.max(0, Math.round(N * pct));
}

function defaultRuleDoc(phaseType) {
  return phaseType === 'pool' ? DEFAULT_POOL_RULE : DEFAULT_DE_RULE;
}

// stage: a schedule_plan_stages row ({ phase_type, rule_doc, estimated_n }).
// competition: { weapon, gender } — from the real competitions row the
// stage belongs to, for bout-duration lookup.
function computeStageMetrics(stage, competition) {
  const N = Math.max(0, Number(stage.estimated_n) || 0);
  if (N < 2) {
    return {
      boutCount: 0, minutesPerBout: 0, totalBoutMinutes: 0, suggestedPistes: 1,
      insufficientN: true,
    };
  }
  const ruleDoc = stage.rule_doc || defaultRuleDoc(stage.phase_type);
  const weaponCode = WEAPON_CODE[competition.weapon] || competition.weapon;
  return stage.phase_type === 'pool'
    ? computePoolStage(N, ruleDoc, weaponCode, competition.gender)
    : computeDeStage(N, ruleDoc, weaponCode, competition.gender);
}

module.exports = {
  computePoolStage,
  computeDeStage,
  deRoundBoutCounts,
  projectAdvancement,
  computeStageMetrics,
  defaultRuleDoc,
};
