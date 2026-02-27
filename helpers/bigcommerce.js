const axios = require('axios');

const BC_BASE = () =>
    `https://api.bigcommerce.com/stores/${process.env.BC_STORE_HASH}`;

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
    const res = await axios.get(
        `${BC_BASE()}/v3/customers?email:in=${encodeURIComponent(email)}`,
        { headers: BC_HEADERS() }
    );
    const data = res.data.data;
    return data && data.length > 0 ? data[0] : null;
}

/**
 * Create a new BigCommerce customer.
 * Returns the created customer object.
 */
async function createCustomer({ email, firstName, lastName }) {
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
            const created = await axios.post(
                `${BC_BASE()}/v3/customers/attributes`,
                {
                    name,
                    type: name === 'building_number' || name === 'floor_number' ? 'string' : 'string',
                    customer_can_edit: false,
                    is_visible: false,
                    is_required: false,
                },
                { headers: BC_HEADERS() }
            );
            attrMap[name] = created.data.data.id;
            console.log(`[BC] Created customer attribute: ${name} (id: ${attrMap[name]})`);
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
        { attribute_id: attrs['latitude'],       customer_id: customerId, val: String(latitude) },
        { attribute_id: attrs['longitude'],      customer_id: customerId, val: String(longitude) },
        { attribute_id: attrs['building_number'],customer_id: customerId, val: String(building) },
        { attribute_id: attrs['floor_number'],   customer_id: customerId, val: String(floor) },
    ].map(({ attribute_id, customer_id, val }) => ({
        attribute_id,
        customer_id,
        attribute_value: val,
    }));

    await axios.put(
        `${BC_BASE()}/v3/customers/attribute-values`,
        values,
        { headers: BC_HEADERS() }
    );

    console.log(`[BC] Saved location for customer ${customerId}: lat=${latitude}, lng=${longitude}, building=${building}, floor=${floor}`);
}

module.exports = { findOrCreateCustomer, saveCustomerLocation };
