const express = require('express');
const axios   = require('axios');
const router  = express.Router();

const BC_BASE    = () => `https://api.bigcommerce.com/stores/${process.env.BC_STORE_HASH}`;
const BC_HEADERS = () => ({
    'X-Auth-Token': process.env.BC_ACCESS_TOKEN,
    'Content-Type': 'application/json',
    Accept: 'application/json',
});

// CORS — allow AJAX from the BC store domain
router.use((req, res, next) => {
    const origin = process.env.BC_STORE_URL || 'https://mozher.com';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// GET /buy/product?slug=ardisia-crenata — fetch product details by custom URL slug
router.get('/product', async (req, res) => {
    const { slug } = req.query;
    if (!slug) return res.status(400).json({ ok: false, error: 'Missing slug' });

    try {
        // BC v3 catalog search by custom_url — try exact match with leading/trailing slash
        const customUrl = '/' + slug + '/';
        const searchRes = await axios.get(
            `${BC_BASE()}/v3/catalog/products?url=${encodeURIComponent(customUrl)}&include=images&limit=1`,
            { headers: BC_HEADERS() }
        );

        let products = searchRes.data.data;

        // Fallback: search all products and match custom_url manually (BC filter can be unreliable)
        if (!products || products.length === 0) {
            const allRes = await axios.get(
                `${BC_BASE()}/v3/catalog/products?include=images&limit=250&is_visible=true`,
                { headers: BC_HEADERS() }
            );
            products = (allRes.data.data || []).filter(p =>
                p.custom_url && p.custom_url.url && p.custom_url.url.replace(/\//g, '') === slug.replace(/\//g, '')
            );
        }

        if (!products || products.length === 0) {
            return res.json({ ok: false, error: 'Product not found' });
        }

        const p = products[0];
        const primaryImage = (p.images || []).find(img => img.is_thumbnail) || (p.images || [])[0];
        const imageUrl = primaryImage ? primaryImage.url_standard : null;

        return res.json({
            ok: true,
            product: {
                id:        p.id,
                name:      p.name,
                price:     p.price,
                image_url: imageUrl,
                category:  null,
            },
        });
    } catch (err) {
        console.error('[Buy] GET /product error:', err.response?.data || err.message);
        return res.status(500).json({ ok: false, error: 'Failed to load product' });
    }
});

// POST /buy/order — receive a product buy form submission
router.post('/order', async (req, res) => {
    const {
        product_id,
        product_slug,
        product_name,
        name,
        phone,
        latitude,
        longitude,
        building,
        floor,
        apartment,
    } = req.body;

    console.log('[Buy] POST /order body:', {
        product_id,
        product_slug,
        product_name,
        name,
        phone: phone ? phone.slice(0, 6) + '...' : '(missing)',
        latitude,
        longitude,
        building,
        floor,
        apartment,
    });

    // Validate required fields
    const missing = [];
    if (!product_slug)  missing.push('product_slug');
    if (!name)          missing.push('name');
    if (!phone)         missing.push('phone');
    if (!latitude)      missing.push('latitude');
    if (!longitude)     missing.push('longitude');
    if (!building)      missing.push('building');
    if (floor === undefined || floor === null || String(floor).trim() === '') missing.push('floor');
    if (!apartment)     missing.push('apartment');

    if (missing.length) {
        console.warn('[Buy] Missing fields:', missing);
        return res.status(400).json({ ok: false, error: 'Missing required fields: ' + missing.join(', ') });
    }

    try {
        await saveBuyOrder({
            product_id,
            product_slug,
            product_name,
            name,
            phone,
            latitude,
            longitude,
            building,
            floor,
            apartment,
        });

        console.log(`[Buy] Order saved for product "${product_slug}" — customer: ${name}`);
        return res.json({ ok: true });

    } catch (err) {
        console.error('[Buy] Failed to save order:', err.message);
        return res.status(500).json({ ok: false, error: 'Failed to save order. Please try again.' });
    }
});

/**
 * Save a buy order as a BigCommerce customer note / custom field.
 * We store it as a new customer with a note containing the order details,
 * or update an existing customer identified by phone number.
 */
async function saveBuyOrder(order) {
    const timestamp = new Date().toISOString();
    const mapsUrl = `https://www.google.com/maps?q=${order.latitude},${order.longitude}`;

    const noteText = [
        `=== BUY ORDER ${timestamp} ===`,
        `Product:   ${order.product_name || order.product_slug} (ID: ${order.product_id || 'n/a'})`,
        `Name:      ${order.name}`,
        `Phone:     ${order.phone}`,
        `Building:  ${order.building}`,
        `Floor:     ${order.floor}`,
        `Apartment: ${order.apartment}`,
        `Location:  ${order.latitude}, ${order.longitude}`,
        `Maps:      ${mapsUrl}`,
        '==============================',
    ].join('\n');

    // Try to find existing customer by phone
    let customerId = null;
    try {
        const searchRes = await axios.get(
            `${BC_BASE()}/v3/customers?phone:in=${encodeURIComponent(order.phone)}`,
            { headers: BC_HEADERS() }
        );
        const existing = searchRes.data.data;
        if (existing && existing.length > 0) {
            customerId = existing[0].id;
        }
    } catch (err) {
        console.warn('[Buy] Could not search customers by phone:', err.message);
    }

    if (customerId) {
        // Append note to existing customer
        const existingCustomer = await axios.get(
            `${BC_BASE()}/v3/customers?id:in=${customerId}`,
            { headers: BC_HEADERS() }
        ).then(r => r.data.data[0]).catch(() => null);

        const existingNote = (existingCustomer && existingCustomer.notes) || '';
        const updatedNote = existingNote ? existingNote + '\n\n' + noteText : noteText;

        await axios.put(
            `${BC_BASE()}/v3/customers`,
            [{ id: customerId, notes: updatedNote }],
            { headers: BC_HEADERS() }
        );
    } else {
        // Create a new customer record for this order
        const [firstName, ...rest] = order.name.trim().split(' ');
        const lastName = rest.join(' ') || '-';

        // Generate a placeholder email from phone to satisfy BC's required email field
        const safePhone = order.phone.replace(/[^0-9]/g, '');
        const placeholderEmail = `order-${safePhone}-${Date.now()}@buy.mozher.com`;

        await axios.post(
            `${BC_BASE()}/v3/customers`,
            [{
                email:      placeholderEmail,
                first_name: firstName,
                last_name:  lastName,
                phone:      order.phone,
                notes:      noteText,
                authentication: { force_reset: false },
            }],
            { headers: BC_HEADERS() }
        );
    }
}

module.exports = router;
