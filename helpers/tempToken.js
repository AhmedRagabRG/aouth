const jwt = require('jsonwebtoken');

const SECRET = () => process.env.TEMP_TOKEN_SECRET || 'change_me_in_env';

/**
 * Sign a short-lived token (10 minutes) to carry customerId between
 * the OAuth callback and the location page.
 */
function sign(payload) {
    return jwt.sign(payload, SECRET(), { expiresIn: '10m' });
}

/**
 * Verify and decode the token. Throws if invalid or expired.
 */
function verify(token) {
    return jwt.verify(token, SECRET());
}

module.exports = { sign, verify };
