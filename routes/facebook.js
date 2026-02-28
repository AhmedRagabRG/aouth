const express = require('express');
const axios = require('axios');
const { findOrCreateCustomer, hasLocationSaved } = require('../helpers/bigcommerce');
const { sign } = require('../helpers/tempToken');
const { buildLoginJwt } = require('../helpers/jwt');

const router = express.Router();

// Falls back to <BC_STORE_URL>/location/ if BC_LOCATION_PAGE_URL is not set
function locationPageUrl() {
    return process.env.BC_LOCATION_PAGE_URL || `${process.env.BC_STORE_URL}/location/`;
}

const FB_AUTH_URL = 'https://www.facebook.com/v18.0/dialog/oauth';
const FB_TOKEN_URL = 'https://graph.facebook.com/v18.0/oauth/access_token';
const FB_PROFILE_URL = 'https://graph.facebook.com/me';

function callbackUrl() {
    return `${process.env.BASE_URL}/oauth/facebook/callback`;
}

// Step 1 — redirect user to Facebook consent screen
router.get('/start', (req, res) => {
    const params = new URLSearchParams({
        client_id: process.env.FB_APP_ID,
        redirect_uri: callbackUrl(),
        scope: 'email',
        response_type: 'code',
    });
    res.redirect(`${FB_AUTH_URL}?${params.toString()}`);
});

// Step 2 — Facebook redirects back here with ?code=
router.get('/callback', async (req, res) => {
    const { code, error } = req.query;

    if (error || !code) {
        console.error('[Facebook] OAuth error:', error);
        return res.redirect(`${process.env.BC_STORE_URL}/login.php?action=create_account`);
    }

    try {
        // Exchange code for access token
        const tokenRes = await axios.get(FB_TOKEN_URL, {
            params: {
                code,
                client_id: process.env.FB_APP_ID,
                client_secret: process.env.FB_APP_SECRET,
                redirect_uri: callbackUrl(),
            },
        });

        const accessToken = tokenRes.data.access_token;

        // Get user profile from Facebook
        const profileRes = await axios.get(FB_PROFILE_URL, {
            params: {
                fields: 'id,email,first_name,last_name',
                access_token: accessToken,
            },
        });

        const { email, first_name: firstName, last_name: lastName } = profileRes.data;

        if (!email) {
            throw new Error('No email returned from Facebook. User may not have a public email.');
        }

        // Find or create BigCommerce customer
        const customerId = await findOrCreateCustomer({ email, firstName, lastName });

        // Skip location page for returning customers who already provided their location
        if (await hasLocationSaved(customerId)) {
            console.log(`[Facebook] Returning customer ${customerId} — skipping location page`);
            const loginJwt = buildLoginJwt(customerId);
            return res.redirect(`${process.env.BC_STORE_URL}/login/token/${loginJwt}`);
        }

        // New customer — collect location first
        const tempToken = sign({ customerId });
        res.redirect(`${locationPageUrl()}?token=${encodeURIComponent(tempToken)}`);

    } catch (err) {
        const status = err.response?.status;
        const detail = typeof err.response?.data === 'string'
            ? err.response.data.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300)
            : JSON.stringify(err.response?.data)?.slice(0, 300);
        console.error(`[Facebook] Callback error (HTTP ${status}):`, detail || err.message);
        res.redirect(`${process.env.BC_STORE_URL}/login.php?action=create_account`);
    }
});

module.exports = router;
