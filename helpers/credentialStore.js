/**
 * Simple file-based credential store for WebAuthn credentials.
 * Stored at: oauth-server/data/credentials.json
 *
 * Schema:
 *   credentials:    { [credentialId_b64url]: { customerId, publicKey_b64url, counter, transports } }
 *   userCredentials: { [customerId]: [credentialId_b64url, ...] }
 */

const fs   = require('fs');
const path = require('path');

const DATA_DIR   = path.join(__dirname, '../data');
const STORE_FILE = path.join(DATA_DIR, 'credentials.json');

function loadStore() {
    try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        if (!fs.existsSync(STORE_FILE)) return { credentials: {}, userCredentials: {} };
        return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    } catch {
        return { credentials: {}, userCredentials: {} };
    }
}

function persist(store) {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
}

/** Save a new credential (or overwrite existing with same id). */
function saveCredential(customerId, credentialId, publicKey, counter, transports) {
    const store = loadStore();
    const cid   = String(customerId);

    store.credentials[credentialId] = { customerId: cid, publicKey, counter, transports: transports || [] };

    if (!store.userCredentials[cid]) store.userCredentials[cid] = [];
    if (!store.userCredentials[cid].includes(credentialId)) {
        store.userCredentials[cid].push(credentialId);
    }
    persist(store);
}

/** Get one credential by its base64url id. Returns null if not found. */
function getCredentialById(credentialId) {
    const store = loadStore();
    return store.credentials[credentialId] || null;
}

/** Get all credentials for a customer. Returns array of { id, ...fields }. */
function getCredentialsByCustomerId(customerId) {
    const store = loadStore();
    const ids   = store.userCredentials[String(customerId)] || [];
    return ids
        .map(id => store.credentials[id] ? { id, ...store.credentials[id] } : null)
        .filter(Boolean);
}

/** Update the counter after a successful authentication. */
function updateCounter(credentialId, newCounter) {
    const store = loadStore();
    if (store.credentials[credentialId]) {
        store.credentials[credentialId].counter = newCounter;
        persist(store);
    }
}

module.exports = { saveCredential, getCredentialById, getCredentialsByCustomerId, updateCounter };
