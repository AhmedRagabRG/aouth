const axios = require('axios');

const BC_BASE = () =>
    `https://api.bigcommerce.com/stores/${process.env.BC_STORE_HASH}`;

// Throws a readable error instead of dumping an HTML page
function bcError(label, err) {
    const status = err.response?.status;
    const body   = err.response?.data;
    const detail = typeof body === 'string'
        ? body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
        : JSON.stringify(body)?.slice(0, 200);
    throw new Error(`[BC:${label}] HTTP ${status}: ${detail || err.message}`);
}

const BC_HEADERS = () => ({
    'X-Auth-Token': process.env.BC_ACCESS_TOKEN,
    'Content-Type': 'application/json',
    Accept: 'application/json',
});

/**
 * Find a BigCommerce customer by email.
 * Returns the customer object or null.
 */
async function findCustomerByEmail(email) {
    try {
        const res = await axios.get(
            `${BC_BASE()}/v3/customers?email:in=${encodeURIComponent(email)}`,
            { headers: BC_HEADERS() }
        );
        const data = res.data.data;
        return data && data.length > 0 ? data[0] : null;
    } catch (err) { bcError('findCustomer', err); }
}

/**
 * Create a new BigCommerce customer.
 * Returns the created customer object.
 */
async function createCustomer({ email, firstName, lastName }) {
    try {
    const res = await axios.post(
        `${BC_BASE()}/v3/customers`,
        [
            {
                email,
                first_name: firstName || '',
                last_name: lastName || '',
                authentication: { force_reset: false },
            },
        ],
        { headers: BC_HEADERS() }
    );
    return res.data.data[0];
    } catch (err) { bcError('createCustomer', err); }
}

/**
 * Find or create a customer, returning the customer ID.
 */
async function findOrCreateCustomer({ email, firstName, lastName }) {
    let customer = await findCustomerByEmail(email);
    if (!customer) {
        console.log(`[BC] Creating new customer: ${email}`);
        customer = await createCustomer({ email, firstName, lastName });
    } else {
        console.log(`[BC] Found existing customer: ${email} (id: ${customer.id})`);
    }
    return customer.id;
}

// Cache attribute IDs so we don't re-fetch every time
let _attrCache = null;

/**
 * Ensure the 4 location customer attributes exist in BC, return their IDs.
 */
async function ensureLocationAttributes() {
    if (_attrCache) return _attrCache;

    const res = await axios.get(`${BC_BASE()}/v3/customers/attributes`, {
        headers: BC_HEADERS(),
    });

    const existing = res.data.data;
    const needed = ['latitude', 'longitude', 'building_number', 'floor_number'];
    const attrMap = {};

    for (const attr of existing) {
        if (needed.includes(attr.name)) {
            attrMap[attr.name] = attr.id;
        }
    }

    // Create any that are missing
    for (const name of needed) {
        if (!attrMap[name]) {
            try {
                // BC v3 requires an ARRAY body for POST /customers/attributes
                const created = await axios.post(
                    `${BC_BASE()}/v3/customers/attributes`,
                    [{ name, type: 'string' }],
                    { headers: BC_HEADERS() }
                );
                attrMap[name] = created.data.data[0].id;
                console.log(`[BC] Created customer attribute: ${name} (id: ${attrMap[name]})`);
            } catch (err) {
                const detail = err.response?.data ? JSON.stringify(err.response.data).slice(0, 200) : err.message;
                console.error(`[BC] Failed to create attribute "${name}" (HTTP ${err.response?.status}):`, detail);
                throw new Error(`Cannot create BC attribute "${name}": ${detail}`);
            }
        }
    }

    _attrCache = attrMap;
    return attrMap;
}

/**
 * Save GPS + building + floor to BigCommerce customer attributes.
 */
async function saveCustomerLocation(customerId, { latitude, longitude, building, floor }) {
    const attrs = await ensureLocationAttributes();

    const values = [
        { attribute_id: attrs['latitude'],        customer_id: customerId, attribute_value: String(latitude) },
        { attribute_id: attrs['longitude'],       customer_id: customerId, attribute_value: String(longitude) },
        { attribute_id: attrs['building_number'], customer_id: customerId, attribute_value: String(building) },
        { attribute_id: attrs['floor_number'],    customer_id: customerId, attribute_value: String(floor) },
    ];

    console.log('[BC] PUT attribute-values payload:', JSON.stringify(values));try {
        await axios.put(
            `${BC_BASE()}/v3/customers/attribute-values`,
            values,
            { headers: BC_HEADERS() }
        );
        console.log(`[BC] Saved location for customer ${customerId}: lat=${latitude}, lng=${longitude}, building=${building}, floor=${floor}`);
    } catch (err) {
        const detail = err.response?.data ? JSON.stringify(err.response.data).slice(0, 300) : err.message;
        console.error(`[BC] Failed to save attribute-values (HTTP ${err.response?.status}):`, detail);
        throw new Error(`Failed to save location attributes: ${detail}`);
    }
}

module.exports = { findOrCreateCustomer, saveCustomerLocation };
