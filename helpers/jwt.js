const crypto = require('crypto');

/**
 * Build a BigCommerce Customer Login JWT
 * Docs: https://developer.bigcommerce.com/docs/rest-authentication/customer-login
 */
function buildLoginJwt(customerId) {
    const {
        BC_CLIENT_ID,
        BC_CLIENT_SECRET,
        BC_STORE_HASH,
        BC_CHANNEL_ID = '1',
    } = process.env;

    function b64url(obj) {
        return Buffer.from(JSON.stringify(obj))
            .toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=/g, '');
    }

    const header = b64url({ alg: 'HS256', typ: 'JWT' });

    const payload = b64url({
        iss: BC_CLIENT_ID,
        iat: Math.floor(Date.now() / 1000),
        jti: crypto.randomUUID(),
        operation: 'customer_login',
        store_hash: BC_STORE_HASH,
        customer_id: parseInt(customerId),
        channel_id: parseInt(BC_CHANNEL_ID),
    });

    const signature = crypto
        .createHmac('sha256', BC_CLIENT_SECRET)
        .update(`${header}.${payload}`)
        .digest('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');

    return `${header}.${payload}.${signature}`;
}

module.exports = { buildLoginJwt };
