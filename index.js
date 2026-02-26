require('dotenv').config();
const express = require('express');
const googleRouter = require('./routes/google');
const facebookRouter = require('./routes/facebook');

const app = express();
const PORT = process.env.PORT || 3030;

app.use(express.json());

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// OAuth routes
app.use('/oauth/google', googleRouter);
app.use('/oauth/facebook', facebookRouter);

// 404 fallback
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Error handler
app.use((err, req, res, next) => {
    console.error('[Error]', err.message);
    res.status(500).json({ error: 'Internal server error', detail: err.message });
});

app.listen(PORT, () => {
    console.log(`OAuth server running on port ${PORT}`);
    console.log(`Google start  → ${process.env.BASE_URL}/oauth/google/start`);
    console.log(`Facebook start → ${process.env.BASE_URL}/oauth/facebook/start`);
});
