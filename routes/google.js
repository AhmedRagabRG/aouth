const express = require('express');
const axios = require('axios');
const { findOrCreateCustomer } = require('../helpers/bigcommerce');
const { sign } = require('../helpers/tempToken');

const router = express.Router();

// Falls back to <BC_STORE_URL>/location/ if BC_LOCATION_PAGE_URL is not set
function locationPageUrl() {
    return process.env.BC_LOCATION_PAGE_URL || `${process.env.BC_STORE_URL}/location/`;
}

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

function callbackUrl() {
    return `${process.env.BASE_URL}/oauth/google/callback`;
}

// Step 1 — redirect user to Google consent screen
router.get('/start', (req, res) => {
    const params = new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        redirect_uri: callbackUrl(),
        response_type: 'code',
        scope: 'email profile',
        access_type: 'offline',
    });
    res.redirect(`${GOOGLE_AUTH_URL}?${params.toString()}`);
});

// Step 2 — Google redirects back here with ?code=
router.get('/callback', async (req, res) => {
    const { code, error } = req.query;

    if (error || !code) {
        console.error('[Google] OAuth error:', error);
        return res.redirect(`${process.env.BC_STORE_URL}/login.php?action=create_account`);
    }

    try {
        // Exchange code for access token
        const tokenRes = await axios.post(
            GOOGLE_TOKEN_URL,
            new URLSearchParams({
                code,
                client_id: process.env.GOOGLE_CLIENT_ID,
                client_secret: process.env.GOOGLE_CLIENT_SECRET,
                redirect_uri: callbackUrl(),
                grant_type: 'authorization_code',
            }).toString(),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );

        const accessToken = tokenRes.data.access_token;

        // Get user profile from Google
        const profileRes = await axios.get(GOOGLE_USERINFO_URL, {
            headers: { Authorization: `Bearer ${accessToken}` },
        });

        const { email, given_name: firstName, family_name: lastName } = profileRes.data;

        if (!email) {
            throw new Error('No email returned from Google profile');
        }

        // Find or create BigCommerce customer
        const customerId = await findOrCreateCustomer({ email, firstName, lastName });

        // Redirect to the BigCommerce theme location page
        const tempToken = sign({ customerId });
        res.redirect(`${locationPageUrl()}?token=${encodeURIComponent(tempToken)}`);

    } catch (err) {
        const status = err.response?.status;
        const detail = typeof err.response?.data === 'string'
            ? err.response.data.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300)
            : JSON.stringify(err.response?.data)?.slice(0, 300);
        console.error(`[Google] Callback error (HTTP ${status}):`, detail || err.message);
        res.redirect(`${process.env.BC_STORE_URL}/login.php?action=create_account`);
    }
});

module.exports = router;
