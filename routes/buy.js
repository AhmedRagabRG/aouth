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

    const normalizedSlug = slug.replace(/\//g, '').toLowerCase();

    try {
        // BC v3 doesn't support url/custom_url filter directly, so paginate and match manually
        let page = 1;
        let found = null;

        while (!found) {
            const pageRes = await axios.get(
                `${BC_BASE()}/v3/catalog/products?include=images&limit=250&page=${page}&is_visible=true`,
                { headers: BC_HEADERS() }
            );

            const { data, meta } = pageRes.data;
            if (!data || data.length === 0) break;

            found = data.find(p =>
                p.custom_url && p.custom_url.url &&
                p.custom_url.url.replace(/\//g, '').toLowerCase() === normalizedSlug
            );

            if (found) break;

            const totalPages = meta && meta.pagination && meta.pagination.total_pages;
            if (!totalPages || page >= totalPages) break;
            page++;
        }

        if (!found) {
            return res.json({ ok: false, error: 'Product not found' });
        }

        const primaryImage = (found.images || []).find(img => img.is_thumbnail) || (found.images || [])[0];

        return res.json({
            ok: true,
            product: {
                id:        found.id,
                name:      found.name,
                price:     found.price,
                image_url: primaryImage ? primaryImage.url_standard : null,
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
        product_price,
        name,
        phone,
        latitude,
        longitude,
        manual_location,
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
    // Location is valid if map coords provided OR manual text written
    const locationProvided = (latitude && longitude) || (manual_location && manual_location.trim());
    if (!locationProvided) missing.push('location (map pin or written address)');
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
            product_price,
            name,
            phone,
            latitude,
            longitude,
            manual_location,
            building,
            floor,
            apartment,
        });

        console.log(`[Buy] Order saved for product "${product_slug}" — customer: ${name}`);
        return res.json({ ok: true });

    } catch (err) {
        console.error('[Buy] Failed to save order:', JSON.stringify(err.response?.data, null, 2) || err.message);
        return res.status(500).json({ ok: false, error: 'Failed to save order. Please try again.' });
    }
});

/**
 * Create a real BigCommerce order via v2 Orders API.
 */
async function saveBuyOrder(order) {
    const [firstName, ...rest] = order.name.trim().split(' ');
    const lastName = rest.join(' ') || '-';
    const safePhone = order.phone.replace(/[^0-9]/g, '');
    const placeholderEmail = `order-${safePhone}@buy.mozher.com`;

    // Build street lines from the address fields
    const street1 = `Building ${order.building}, Floor ${order.floor}, Apt ${order.apartment}`;
    const street2 = order.manual_location || '';

    // Find or create BC customer by phone
    let customerId = 0;
    try {
        const searchRes = await axios.get(
            `${BC_BASE()}/v3/customers?phone:in=${encodeURIComponent(order.phone)}`,
            { headers: BC_HEADERS() }
        );
        const existing = searchRes.data.data;
        if (existing && existing.length > 0) {
            customerId = existing[0].id;
        } else {
            const created = await axios.post(
                `${BC_BASE()}/v3/customers`,
                [{
                    email:      placeholderEmail,
                    first_name: firstName,
                    last_name:  lastName,
                    phone:      order.phone,
                    authentication: { force_reset: false },
                }],
                { headers: BC_HEADERS() }
            );
            customerId = created.data.data[0].id;
            console.log(`[Buy] Created customer id=${customerId}`);
        }
    } catch (err) {
        console.warn('[Buy] Customer find/create failed, using guest order:', err.message);
    }

    // Fetch confirmed product price + default variant_id from BC
    let productName = order.product_name || order.product_slug;
    let productPrice = parseFloat(order.product_price) || 0;
    let variantId = null;
    if (order.product_id) {
        try {
            const pRes = await axios.get(
                `${BC_BASE()}/v3/catalog/products/${order.product_id}?include=variants`,
                { headers: BC_HEADERS() }
            );
            const p = pRes.data.data;
            productPrice = p.price || productPrice;
            productName  = p.name  || productName;
            if (p.variants && p.variants.length > 0) {
                variantId = p.variants[0].id;
            }
        } catch (err) {
            console.warn('[Buy] Could not fetch product/variant:', err.message);
        }
    }

    const productLine = { product_id: parseInt(order.product_id, 10), quantity: 1 };
    if (variantId) productLine.variant_id = variantId;
    console.log('[Buy] product line:', JSON.stringify(productLine));

    const orderPayload = {
        customer_id: customerId,
        billing_address: {
            first_name:        firstName,
            last_name:         lastName,
            street_1:          street1,
            street_2:          street2,
            city:              'Baghdad',
            state:             'Baghdad',
            zip:               '10001',
            country:           'Iraq',
            country_iso2:      'IQ',
            phone:             order.phone,
            email:             placeholderEmail,
        },
        products: [productLine],
        staff_notes:      `Building: ${order.building} | Floor: ${order.floor} | Apt: ${order.apartment}${street2 ? ' | Location: ' + street2 : ''}`,
        customer_message: `Name: ${order.name} | Phone: ${order.phone}`,
        status_id: 1,
    };

    const orderRes = await axios.post(
        `${BC_BASE()}/v2/orders`,
        orderPayload,
        { headers: BC_HEADERS() }
    );

    const bcOrderId = orderRes.data.id;
    console.log(`[Buy] BC order created: id=${bcOrderId} for "${productName}" — ${order.name}`);
    return bcOrderId;
}

module.exports = router;
