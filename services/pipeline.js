'use strict';
// Orchestrator — recombines the split-out pieces into the same public
// `Pipeline` API every existing caller (routes/, lib/opp2Client.js,
// lib/opp2Composer.js, services/pools.js) already uses, so nothing outside
// this file needed to change. Split 2026-07-29 (architecture review — see
// CLAUDE.md's "Architecture / code hygiene" §3 and memory
// project_pipeline_split) because the original 1348-line file bundled slot
// CRUD, officiating roster, the live OPP2 bout-navigation hot path, DE
// partition math, and kiosk roster resolution — six-plus distinct concerns
// in one file.
//
//   services/pipelineSlots.js   — slot CRUD, officiating roster, referee
//                                 double-booking enforcement
//   services/pipelineNav.js     — activeSlot/markActive/markDone,
//                                 pendingBoutCount, nextBout/prevBout, relay
//                                 resolution (the live OPP2 hot path)
//   services/pipelineRosters.js — competitorsForSlot/fencersForCompetition
//                                 (kiosk waiting-room displays)
//   lib/deSlotMath.js           — pure DE tableau/partition/de_round math
//                                 shared by all three above
//
// None of the split files call each other via `this.` — every cross-method
// reference either stays within one file (called as a plain function or via
// the file's own exported const) or is an explicit require of the sibling
// file it actually needs (pipelineNav needs pipelineSlots.findById;
// pipelineRosters needs pipelineSlots.findAllStrips). This sidesteps the
// `this`-binding hazard the services/phases.js split ran into: a bare
// `Pipeline.addSlot = PipelineSlots.addSlot` reference works correctly
// regardless of what object it's invoked through, since nothing inside it
// depends on the caller's `this`.
const PipelineSlots   = require('./pipelineSlots');
const PipelineNav     = require('./pipelineNav');
const PipelineRosters = require('./pipelineRosters');

module.exports = {
  ...PipelineSlots,
  ...PipelineNav,
  ...PipelineRosters,
};
