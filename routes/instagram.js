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

// Instagram API via Meta (Basic Display API was shut down Dec 2024)
const IG_AUTH_URL  = 'https://www.instagram.com/oauth/authorize';
const IG_TOKEN_URL = 'https://api.instagram.com/oauth/access_token';
const IG_PROFILE_URL = 'https://graph.instagram.com/v21.0/me';

function callbackUrl() {
    return `${process.env.BASE_URL}/oauth/instagram/callback`;
}

// Step 1 — redirect user to Instagram consent screen
router.get('/start', (req, res) => {
    const params = new URLSearchParams({
        client_id: process.env.IG_APP_ID,
        redirect_uri: callbackUrl(),
        // instagram_business_basic gives id/username/name; email scope available where permitted
        scope: 'instagram_business_basic,email',
        response_type: 'code',
    });
    res.redirect(`${IG_AUTH_URL}?${params.toString()}`);
});

// Step 2 — Instagram redirects back here with ?code=
router.get('/callback', async (req, res) => {
    const { code, error } = req.query;

    if (error || !code) {
        console.error('[Instagram] OAuth error:', error);
        return res.redirect(`${process.env.BC_STORE_URL}/login.php?action=create_account`);
    }

    try {
        // Exchange code for access token
        const tokenRes = await axios.post(
            IG_TOKEN_URL,
            new URLSearchParams({
                code,
                client_id: process.env.IG_APP_ID,
                client_secret: process.env.IG_APP_SECRET,
                redirect_uri: callbackUrl(),
                grant_type: 'authorization_code',
            }).toString(),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );

        const { access_token: accessToken, user_id: igUserId } = tokenRes.data;

        // Get user profile from Instagram
        const profileRes = await axios.get(IG_PROFILE_URL, {
            params: {
                fields: 'id,username,name,email',
                access_token: accessToken,
            },
        });

        const { email, name, username } = profileRes.data;

        // Instagram doesn't guarantee returning an email — fall back to a stable synthetic one
        // so findOrCreateCustomer always has a unique, consistent identifier for this IG user.
        const resolvedEmail = email || `ig_${igUserId}@instagram.placeholder`;

        // Split name into first/last — fall back to username if Instagram didn't return a display name
        const parts = (name || '').trim().split(/\s+/);
        const firstName = parts[0] || username || 'Instagram';
        const lastName  = parts.slice(1).join(' ')  || 'User';

        // Find or create BigCommerce customer
        const customerId = await findOrCreateCustomer({ email: resolvedEmail, firstName, lastName });

        // Skip location page for returning customers who already provided their location
        if (await hasLocationSaved(customerId)) {
            console.log(`[Instagram] Returning customer ${customerId} — skipping location page`);
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
        console.error(`[Instagram] Callback error (HTTP ${status}):`, detail || err.message);
        res.redirect(`${process.env.BC_STORE_URL}/login.php?action=create_account`);
    }
});

module.exports = router;
