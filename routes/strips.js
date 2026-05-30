const express = require('express');
const db = require('../db/db');
console.log('DEBUG: typeof db =', typeof db, 'keys:', Object.keys(db));
const router = express.Router();



// Get all strips

router.get('/', async (req, res) => {
    try {
        const strips = await req.app.get('models').Strip.findAll({
            attributes: ['id', 'strip_number', 'name', 'status', 'state', 'network_state'],
            order: [['strip_number', 'ASC']]
        });
        res.json(strips);
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch strips.' });
    }
});

// Add a new strip
router.post('/', async (req, res) => {
    const { strip_number, name } = req.body;
    if (!strip_number || strip_number < 1) {
        return res.status(400).json({ error: 'Strip number is required and must be >= 1.' });
    }
    try {
        await req.app.get('models').Strip.create({
            strip_number,
            name: name || null,
            status: 'idle'
        });
        res.status(201).json({ success: true });
    } catch (e) {
        if (e.message && e.message.includes('UNIQUE')) {
            res.status(400).json({ error: 'Strip number must be unique.' });
        } else {
            res.status(500).json({ error: 'Failed to add strip.' });
        }
    }
});

module.exports = router;
