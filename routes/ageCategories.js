'use strict';
const express     = require('express');
const AgeCategory = require('../services/ageCategories');

const router = express.Router();

router.get('/', (req, res) => {
  res.json(AgeCategory.findAll());
});

router.post('/', (req, res) => {
  try {
    const ac = AgeCategory.create(req.body);
    res.status(201).json(ac);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.patch('/:id', (req, res) => {
  const ac = AgeCategory.update(req.params.id, req.body);
  if (!ac) return res.status(404).json({ error: 'Age category not found' });
  res.json(ac);
});

router.delete('/:id', (req, res) => {
  const result = AgeCategory.delete(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Age category not found' });
  res.json({ ok: true });
});

module.exports = router;
