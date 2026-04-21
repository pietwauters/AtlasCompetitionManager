const express = require('express');
const db = require('../db/db');
console.log('DEBUG: typeof db =', typeof db, 'keys:', Object.keys(db));
const router = express.Router();



// Get all strips
router.get('/', (req, res) => {
    try {
        const strips = db.prepare('SELECT id, strip_number, name, status FROM strips ORDER BY strip_number').all();
        res.json(strips);
    } catch (e) {
        res.status(500).json({ error: 'Failed to fetch strips.' });
    }
});

// Add a new strip
router.post('/', (req, res) => {
    console.log('POST /api/strips body:', req.body);
    const { strip_number, name } = req.body;
    if (!strip_number || strip_number < 1) {
        console.log('Invalid strip_number:', strip_number);
        return res.status(400).json({ error: 'Strip number is required and must be >= 1.' });
    }
    try {
        db.prepare('INSERT INTO strips (strip_number, name, status) VALUES (?, ?, ?)').run(strip_number, name || null, 'idle');
        res.status(201).json({ success: true });
    } catch (e) {
        console.error('Error inserting strip:', e);
        if (e.message && e.message.includes('UNIQUE')) {
            res.status(400).json({ error: 'Strip number must be unique.' });
        } else {
            res.status(500).json({ error: 'Failed to add strip.' });
        }
    }
});

module.exports = router;
