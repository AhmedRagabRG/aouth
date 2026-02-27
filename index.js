require('dotenv').config();
const express = require('express');
const googleRouter = require('./routes/google');
const facebookRouter = require('./routes/facebook');
const locationRouter = require('./routes/location');

const app = express();
const PORT = process.env.PORT || 3030;

app.use(express.json());
app.use(express.urlencoded({ extended: true })); // needed for location form POST

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// OAuth routes
app.use('/oauth/google', googleRouter);
app.use('/oauth/facebook', facebookRouter);
app.use('/location', locationRouter);

// 404 fallback
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Error handler
app.use((err, req, res, next) => {
    console.error('[Error]', err.message);
    res.status(500).json({ error: 'Internal server error', detail: err.message });
});

app.listen(PORT, () => {
    console.log(`OAuth server running on port ${PORT}`);
    console.log(`Google start   → ${process.env.BASE_URL}/oauth/google/start`);
    console.log(`Facebook start → ${process.env.BASE_URL}/oauth/facebook/start`);

    // Warn about missing optional but important env vars
    const important = ['BC_LOCATION_PAGE_URL', 'TEMP_TOKEN_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'FB_APP_ID', 'FB_APP_SECRET', 'BC_CLIENT_SECRET', 'BC_ACCESS_TOKEN', 'BC_STORE_HASH'];
    const missing = important.filter(k => !process.env[k] || process.env[k].startsWith('your_'));
    if (missing.length) {
        console.warn('[WARN] Missing or placeholder env vars:', missing.join(', '));
    } else {
        console.log(`Location page  → ${process.env.BC_LOCATION_PAGE_URL}`);
    }
    // Log masked BC credentials so we can verify they loaded
    const hash = process.env.BC_STORE_HASH || '(not set)';
    const token = process.env.BC_ACCESS_TOKEN ? process.env.BC_ACCESS_TOKEN.slice(0,6) + '...' : '(not set)';
    console.log(`[BC] Store hash: ${hash}  |  Access token: ${token}`);
});
