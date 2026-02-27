/**
 * WebAuthn (biometric) routes — Face ID, Touch ID, Windows Hello, etc.
 *
 * Endpoints:
 *   POST /webauthn/register/options   – generate registration options (needs temp token)
 *   POST /webauthn/register/verify    – verify + store credential
 *   GET  /webauthn/authenticate/options – generate authentication challenge
 *   POST /webauthn/authenticate/verify  – verify + issue BC login JWT
 */

const express  = require('express');
const {
    generateRegistrationOptions,
    verifyRegistrationResponse,
    generateAuthenticationOptions,
    verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const { verify: verifyTempToken } = require('../helpers/tempToken');
const { buildLoginJwt }           = require('../helpers/jwt');
const credStore                   = require('../helpers/credentialStore');

const router = express.Router();

// ── Config (from .env) ───────────────────────────────────────────────────────
const RP_NAME = () => process.env.RP_NAME   || 'Mozher Store';
const RP_ID   = () => process.env.RP_ID     || 'mozher.com';
const ORIGIN  = () => process.env.RP_ORIGIN || 'https://mozher.com';

// ── CORS — allow calls from the BC store domain ──────────────────────────────
router.use((req, res, next) => {
    const origin = ORIGIN();
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// ── In-memory challenge store (TTL: 5 min) ───────────────────────────────────
const challenges = new Map();
setInterval(() => {
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const [k, v] of challenges) {
        if (v.ts < cutoff) challenges.delete(k);
    }
}, 60_000);

// ── Helper: base64url <-> Buffer ─────────────────────────────────────────────
const b64url = {
    fromBuffer: (buf) => Buffer.from(buf).toString('base64url'),
    toBuffer:   (str) => Buffer.from(str, 'base64url'),
};

// ════════════════════════════════════════════════════════════════════════════
// REGISTRATION
// ════════════════════════════════════════════════════════════════════════════

/**
 * POST /webauthn/register/options
 * Body: { token: <tempToken> }
 * Returns: PublicKeyCredentialCreationOptionsJSON
 */
router.post('/register/options', async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Missing token' });

    let payload;
    try { payload = verifyTempToken(token); }
    catch { return res.status(401).json({ error: 'Session expired — please log in again' }); }

    const customerId = String(payload.customerId);

    // Exclude already-registered credentials so user cannot double-register
    const existingCreds = credStore.getCredentialsByCustomerId(customerId);

    const options = await generateRegistrationOptions({
        rpName:  RP_NAME(),
        rpID:    RP_ID(),
        userID:  customerId,
        userName: `customer_${customerId}`,
        attestationType: 'none',
        excludeCredentials: existingCreds.map(c => ({
            id: b64url.toBuffer(c.id),
            type: 'public-key',
            transports: c.transports,
        })),
        authenticatorSelection: {
            authenticatorAttachment: 'platform', // internal: Face ID / Touch ID only
            userVerification: 'required',
            residentKey: 'preferred',
        },
        supportedAlgorithmIDs: [-7, -257], // ES256, RS256
    });

    challenges.set(`reg_${customerId}`, { challenge: options.challenge, ts: Date.now() });
    console.log(`[WebAuthn] Registration options generated for customer ${customerId}`);
    res.json(options);
});

/**
 * POST /webauthn/register/verify
 * Body: { token: <tempToken>, credential: <AuthenticatorAttestationResponseJSON> }
 */
router.post('/register/verify', async (req, res) => {
    const { token, credential } = req.body;
    if (!token || !credential) return res.status(400).json({ error: 'Missing params' });

    let payload;
    try { payload = verifyTempToken(token); }
    catch { return res.status(401).json({ error: 'Session expired' }); }

    const customerId = String(payload.customerId);
    const stored = challenges.get(`reg_${customerId}`);
    if (!stored) return res.status(400).json({ error: 'No pending challenge — start again' });

    try {
        const { verified, registrationInfo } = await verifyRegistrationResponse({
            response: credential,
            expectedChallenge: stored.challenge,
            expectedOrigin: ORIGIN(),
            expectedRPID: RP_ID(),
            requireUserVerification: true,
        });

        if (!verified || !registrationInfo) {
            return res.status(400).json({ error: 'Biometric verification failed' });
        }

        const credId  = b64url.fromBuffer(registrationInfo.credentialID);
        const pubKey  = b64url.fromBuffer(registrationInfo.credentialPublicKey);
        const counter = registrationInfo.counter;
        const transports = credential.response?.transports || ['internal'];

        credStore.saveCredential(customerId, credId, pubKey, counter, transports);
        challenges.delete(`reg_${customerId}`);

        console.log(`[WebAuthn] Registered credential for customer ${customerId}: ${credId.slice(0, 16)}…`);
        res.json({ ok: true });
    } catch (err) {
        console.error('[WebAuthn] Register verify error:', err.message);
        res.status(400).json({ error: err.message });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// AUTHENTICATION
// ════════════════════════════════════════════════════════════════════════════

/**
 * GET /webauthn/authenticate/options
 * No auth required. Returns challenge + sessionId.
 */
router.get('/authenticate/options', async (req, res) => {
    const options = await generateAuthenticationOptions({
        rpID: RP_ID(),
        userVerification: 'required',
        allowCredentials: [], // empty = let device pick any matching credential
    });

    // Tie challenge to a random session ID (returned to client, used in verify)
    const sessionId = `auth_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    challenges.set(sessionId, { challenge: options.challenge, ts: Date.now() });

    res.json({ ...options, sessionId });
});

/**
 * POST /webauthn/authenticate/verify
 * Body: { sessionId, credential: <AuthenticatorAssertionResponseJSON> }
 * Returns: { ok: true, redirectUrl } on success
 */
router.post('/authenticate/verify', async (req, res) => {
    const { sessionId, credential } = req.body;
    if (!sessionId || !credential) return res.status(400).json({ error: 'Missing params' });

    const stored = challenges.get(sessionId);
    if (!stored) return res.status(400).json({ error: 'Challenge expired — please try again' });

    // Look up the credential in our store
    const credId    = credential.id; // base64url string
    const storedCred = credStore.getCredentialById(credId);
    if (!storedCred) {
        return res.status(404).json({
            error: 'Biometric not set up for this account. Please sign in with Google or Facebook first.',
        });
    }

    try {
        const { verified, authenticationInfo } = await verifyAuthenticationResponse({
            response: credential,
            expectedChallenge: stored.challenge,
            expectedOrigin: ORIGIN(),
            expectedRPID: RP_ID(),
            authenticator: {
                credentialID:        b64url.toBuffer(storedCred.id || credId),
                credentialPublicKey: b64url.toBuffer(storedCred.publicKey),
                counter:             storedCred.counter,
                transports:          storedCred.transports,
            },
            requireUserVerification: true,
        });

        if (!verified) return res.status(400).json({ error: 'Authentication failed' });

        credStore.updateCounter(credId, authenticationInfo.newCounter);
        challenges.delete(sessionId);

        const loginJwt = buildLoginJwt(parseInt(storedCred.customerId, 10));
        const redirectUrl = `${process.env.BC_STORE_URL}/login/token/${loginJwt}`;

        console.log(`[WebAuthn] Authenticated customer ${storedCred.customerId}`);
        res.json({ ok: true, redirectUrl });

    } catch (err) {
        console.error('[WebAuthn] Auth verify error:', err.message);
        res.status(400).json({ error: err.message });
    }
});

module.exports = router;
