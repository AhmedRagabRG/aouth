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
    const needed = ['latitude', 'longitude', 'building_number', 'floor_number', 'apartment_number'];
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
async function saveCustomerLocation(customerId, { latitude, longitude, building, floor, apartment }) {
    const attrs = await ensureLocationAttributes();

    // BC requires customer_id and attribute_id to be integers — coerce explicitly
    const cid = parseInt(customerId, 10);
    console.log('[BC] attrMap:', JSON.stringify(attrs));
    console.log('[BC] customerId (raw):', customerId, '| parsed:', cid);

    const values = [
        { attribute_id: parseInt(attrs['latitude'],         10), customer_id: cid, value: String(latitude) },
        { attribute_id: parseInt(attrs['longitude'],        10), customer_id: cid, value: String(longitude) },
        { attribute_id: parseInt(attrs['building_number'], 10), customer_id: cid, value: String(building) },
        { attribute_id: parseInt(attrs['floor_number'],    10), customer_id: cid, value: String(floor) },
        { attribute_id: parseInt(attrs['apartment_number'],10), customer_id: cid, value: String(apartment) },
    ];

    console.log('[BC] PUT attribute-values payload:', JSON.stringify(values));

    try {
        await axios.put(
            `${BC_BASE()}/v3/customers/attribute-values`,
            values,
            { headers: BC_HEADERS() }
        );
        console.log(`[BC] Saved location for customer ${customerId}: lat=${latitude}, lng=${longitude}, building=${building}, floor=${floor}, apt=${apartment}`);
    } catch (err) {
        const detail = err.response?.data ? JSON.stringify(err.response.data).slice(0, 300) : err.message;
        console.error(`[BC] Failed to save attribute-values (HTTP ${err.response?.status}):`, detail);
        throw new Error(`Failed to save location attributes: ${detail}`);
    }
}

/**
 * Reverse geocode lat/lng using OpenStreetMap Nominatim (free, no key needed).
 * Returns { city, state, postalCode, countryCode }.
 */
async function reverseGeocode(latitude, longitude) {
    try {
        const res = await axios.get('https://nominatim.openstreetmap.org/reverse', {
            params: { lat: latitude, lon: longitude, format: 'json' },
            headers: { 'User-Agent': 'mozher-store-oauth/1.0' },
            timeout: 5000,
        });
        const a = res.data.address || {};
        return {
            city:        a.city || a.town || a.village || a.county || '',
            state:       a.state || a.region || '',
            postalCode:  a.postcode || '',
            countryCode: (a.country_code || 'EG').toUpperCase(),
        };
    } catch (err) {
        console.warn('[Geocode] Reverse geocode failed, using fallbacks:', err.message);
        return { city: 'Cairo', state: 'Cairo', postalCode: '11511', countryCode: 'EG' };
    }
}

/**
 * Save (create or update) a customer address with building + floor + GPS.
 */
async function saveCustomerAddress(customerId, { latitude, longitude, building, floor, apartment }) {
    const cid = parseInt(customerId, 10);

    // Get customer info so we have their name for the address record
    let firstName = 'Customer', lastName = String(cid);
    try {
        const custRes = await axios.get(
            `${BC_BASE()}/v3/customers?id:in=${cid}`,
            { headers: BC_HEADERS() }
        );
        const c = custRes.data.data?.[0];
        if (c) { firstName = c.first_name || firstName; lastName = c.last_name || lastName; }
    } catch (_) { /* non-fatal — use fallback name */ }

    // Check for existing address
    let existingId = null;
    try {
        const addrRes = await axios.get(
            `${BC_BASE()}/v3/customers/addresses?customer_id:in=${cid}`,
            { headers: BC_HEADERS() }
        );
        existingId = addrRes.data.data?.[0]?.id || null;
    } catch (_) { /* non-fatal */ }

    // Reverse geocode to get real city/state/postal from GPS
    const geo = await reverseGeocode(latitude, longitude);
    console.log('[Geocode] Resolved:', JSON.stringify(geo));

    const addressPayload = [{
        customer_id:       cid,
        first_name:        firstName,
        last_name:         lastName,
        address1:          `Building ${building}, Floor ${floor}, Apt ${apartment}`,
        address2:          `https://www.google.com/maps?q=${latitude},${longitude}`,

        city:              geo.city,
        country_code:      geo.countryCode,
        state_or_province: geo.state,
        postal_code:       geo.postalCode,
        phone:             '',
        address_type:      'residential',
    }];

    if (existingId) {
        // Update existing address
        addressPayload[0].id = existingId;
        try {
            await axios.put(
                `${BC_BASE()}/v3/customers/addresses`,
                addressPayload,
                { headers: BC_HEADERS() }
            );
            console.log(`[BC] Updated address (id: ${existingId}) for customer ${cid}`);
        } catch (err) {
            const detail = err.response?.data ? JSON.stringify(err.response.data).slice(0, 300) : err.message;
            console.error(`[BC] Failed to update address (HTTP ${err.response?.status}):`, detail);
            throw new Error(detail);
        }
    } else {
        // Create new address
        try {
            await axios.post(
                `${BC_BASE()}/v3/customers/addresses`,
                addressPayload,
                { headers: BC_HEADERS() }
            );
            console.log(`[BC] Created address for customer ${cid}`);
        } catch (err) {
            const detail = err.response?.data ? JSON.stringify(err.response.data).slice(0, 300) : err.message;
            console.error(`[BC] Failed to create address (HTTP ${err.response?.status}):`, detail);
            throw new Error(detail);
        }
    }
}

module.exports = { findOrCreateCustomer, saveCustomerLocation, saveCustomerAddress };
