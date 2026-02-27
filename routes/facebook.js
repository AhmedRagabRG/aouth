const express = require('express');
const axios = require('axios');
const { findOrCreateCustomer } = require('../helpers/bigcommerce');
const { sign } = require('../helpers/tempToken');

const router = express.Router();

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

        // Redirect to location page with a short-lived token
        const tempToken = sign({ customerId });
        res.redirect(`${process.env.BASE_URL}/location?token=${encodeURIComponent(tempToken)}`);

    } catch (err) {
        console.error('[Facebook] Callback error:', err.response?.data || err.message);
        res.redirect(`${process.env.BC_STORE_URL}/login.php?action=create_account`);
    }
});

module.exports = router;
