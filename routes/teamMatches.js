'use strict';

const express    = require('express');
const TeamMatch  = require('../services/teamMatches');
const TeamPhase  = require('../services/teamPhases');

const router = express.Router();

// ── Team matches ──────────────────────────────────────────────────────────────

router.get('/team-matches/:id', (req, res) => {
  const m = TeamMatch.findById(req.params.id);
  if (!m) return res.status(404).json({ error: 'Match not found' });
  res.json(m);
});

router.get('/team-matches/:id/relays', (req, res) => {
  try {
    res.json(TeamMatch.getRelays(req.params.id));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.post('/team-matches/:id/draw', (req, res) => {
  try {
    const { method, winner_team_id } = req.body;
    if (!method) return res.status(400).json({ error: 'method required (auto or manual)' });
    res.json(TeamMatch.draw(req.params.id, winner_team_id ?? null, method));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.post('/team-matches/:id/orders', (req, res) => {
  try {
    const { team_id, positions } = req.body;
    if (!team_id || !positions) return res.status(400).json({ error: 'team_id and positions required' });
    res.json(TeamMatch.submitOrder(req.params.id, team_id, positions));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.post('/team-matches/:id/substitute', (req, res) => {
  try {
    const { team_id, position_replaced, effective_from_relay } = req.body;
    if (!team_id || !position_replaced || !effective_from_relay) {
      return res.status(400).json({ error: 'team_id, position_replaced, effective_from_relay required' });
    }
    res.json(TeamMatch.applySubstitution(
      req.params.id, team_id, Number(position_replaced), Number(effective_from_relay)
    ));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.post('/team-matches/:id/tiebreak', (req, res) => {
  try {
    const { winner_team_id } = req.body;
    if (!winner_team_id) return res.status(400).json({ error: 'winner_team_id required' });
    res.json(TeamMatch.recordTiebreakWinner(req.params.id, winner_team_id));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.post('/team-matches/:id/simulate', (req, res) => {
  try {
    TeamMatch.simulate(req.params.id);
    res.json(TeamMatch.findById(req.params.id));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ── Relays ────────────────────────────────────────────────────────────────────

router.patch('/relays/:id', (req, res) => {
  try {
    const { left_touches, right_touches, time_expired } = req.body;
    if (left_touches == null || right_touches == null) {
      return res.status(400).json({ error: 'left_touches and right_touches required' });
    }
    res.json(TeamMatch.updateRelay(req.params.id, {
      leftTouches:  Number(left_touches),
      rightTouches: Number(right_touches),
      timeExpired:  time_expired ? 1 : 0,
    }));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.post('/relays/:id/undo', (req, res) => {
  try {
    res.json(TeamMatch.undo(req.params.id));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ── Team phases ───────────────────────────────────────────────────────────────

router.get('/team-phases/:id', (req, res) => {
  const ph = TeamPhase.findById(req.params.id);
  if (!ph) return res.status(404).json({ error: 'Phase not found' });
  res.json(ph);
});

router.post('/team-phases', (req, res) => {
  try {
    const { competition_id, rule_doc } = req.body;
    if (!competition_id || !rule_doc) {
      return res.status(400).json({ error: 'competition_id and rule_doc required' });
    }
    const phase = TeamPhase.create(competition_id, rule_doc);
    res.status(201).json(phase);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.post('/team-phases/:id/activate', (req, res) => {
  try {
    res.json(TeamPhase.activate(req.params.id));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.post('/team-phases/:id/close', (req, res) => {
  try {
    res.json(TeamPhase.close(req.params.id));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.post('/team-phases/:id/simulate', (req, res) => {
  try {
    TeamPhase.simulate(req.params.id);
    TeamPhase.activate(req.params.id); // no-op if already active — handle gracefully
    res.json(TeamPhase.findById(req.params.id));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

module.exports = router;
