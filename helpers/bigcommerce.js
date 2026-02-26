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

module.exports = { findOrCreateCustomer };
