const express = require('express');
const { verify } = require('../helpers/tempToken');
const { saveCustomerLocation, saveCustomerAddress } = require('../helpers/bigcommerce');
const { buildLoginJwt } = require('../helpers/jwt');

const router = express.Router();

// GET /location?token=xxx  — show the location form
router.get('/', (req, res) => {
    const { token } = req.query;

    if (!token) {
        return res.redirect(`${process.env.BC_STORE_URL}/login.php`);
    }

    // Location page is now served by the BigCommerce theme
    return res.redirect(`${process.env.BC_LOCATION_PAGE_URL}?token=${encodeURIComponent(token)}`);

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Almost there — Set Your Location</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: #f6f7f9;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .card {
            background: #fff;
            border-radius: 12px;
            box-shadow: 0 4px 24px rgba(0,0,0,0.08);
            padding: 40px 36px;
            width: 100%;
            max-width: 440px;
        }
        .card h1 {
            font-size: 22px;
            font-weight: 700;
            color: #1a1a2e;
            margin-bottom: 8px;
        }
        .card p.sub {
            font-size: 14px;
            color: #666;
            margin-bottom: 28px;
            line-height: 1.5;
        }
        .gps-btn {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
            width: 100%;
            padding: 13px;
            border-radius: 8px;
            border: 2px dashed #c0c8d8;
            background: #f0f4ff;
            color: #3a5bd9;
            font-size: 15px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
            margin-bottom: 12px;
        }
        .gps-btn:hover { background: #e0e8ff; border-color: #3a5bd9; }
        .gps-btn.success { background: #e8f9f0; border-color: #28a745; color: #28a745; }
        .gps-btn.error { background: #fff0f0; border-color: #dc3545; color: #dc3545; }
        .gps-status {
            font-size: 13px;
            color: #888;
            text-align: center;
            margin-bottom: 20px;
            min-height: 18px;
        }
        .divider {
            border: none;
            border-top: 1px solid #eee;
            margin: 20px 0;
        }
        .form-group { margin-bottom: 18px; }
        label {
            display: block;
            font-size: 13px;
            font-weight: 600;
            color: #444;
            margin-bottom: 6px;
        }
        input[type="text"], input[type="number"] {
            width: 100%;
            padding: 11px 14px;
            border: 1px solid #dde1ea;
            border-radius: 8px;
            font-size: 15px;
            color: #222;
            outline: none;
            transition: border 0.2s;
        }
        input:focus { border-color: #3a5bd9; box-shadow: 0 0 0 3px rgba(58,91,217,0.1); }
        .submit-btn {
            width: 100%;
            padding: 14px;
            background: #1a1a2e;
            color: #fff;
            border: none;
            border-radius: 8px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: background 0.2s;
            margin-top: 8px;
        }
        .submit-btn:hover { background: #2d2d50; }
        .submit-btn:disabled { background: #aaa; cursor: not-allowed; }
        .error-msg { color: #dc3545; font-size: 13px; margin-top: 10px; text-align: center; }
    </style>
</head>
<body>
    <div class="card">
        <h1>One last step 📍</h1>
        <p class="sub">We need your location so we can deliver to you accurately. Please share your GPS location and enter your building & floor details.</p>

        <button type="button" class="gps-btn" id="gpsBtn" onclick="getLocation()">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>
                <circle cx="12" cy="12" r="10" stroke-dasharray="2 4"/>
            </svg>
            Tap to get my GPS location
        </button>
        <p class="gps-status" id="gpsStatus">Location not captured yet</p>

        <hr class="divider">

        <form id="locationForm" method="POST" action="/location/save">
            <input type="hidden" name="token" value="${token}">
            <input type="hidden" name="latitude" id="latInput">
            <input type="hidden" name="longitude" id="lngInput">

            <div class="form-group">
                <label for="building">Building Number *</label>
                <input type="text" id="building" name="building" placeholder="e.g. 12" required autocomplete="off">
            </div>
            <div class="form-group">
                <label for="floor">Floor Number *</label>
                <input type="number" id="floor" name="floor" placeholder="e.g. 3" required autocomplete="off" min="0">
            </div>

            <button type="submit" class="submit-btn" id="submitBtn" disabled>
                Continue to Store →
            </button>
            <p class="error-msg" id="errorMsg"></p>
        </form>
    </div>

    <script>
        let locationCaptured = false;

        function getLocation() {
            const btn = document.getElementById('gpsBtn');
            const status = document.getElementById('gpsStatus');

            if (!navigator.geolocation) {
                status.textContent = 'GPS not supported by your browser.';
                btn.className = 'gps-btn error';
                return;
            }

            btn.textContent = 'Getting location…';
            btn.disabled = true;
            status.textContent = 'Requesting GPS…';

            navigator.geolocation.getCurrentPosition(
                (pos) => {
                    const lat = pos.coords.latitude.toFixed(7);
                    const lng = pos.coords.longitude.toFixed(7);

                    document.getElementById('latInput').value = lat;
                    document.getElementById('lngInput').value = lng;

                    btn.innerHTML = '✓ Location captured (' + lat + ', ' + lng + ')';
                    btn.className = 'gps-btn success';
                    btn.disabled = false;
                    status.textContent = 'Accuracy: ±' + Math.round(pos.coords.accuracy) + ' meters';

                    locationCaptured = true;
                    checkSubmit();
                },
                (err) => {
                    btn.innerHTML = '✗ Could not get location — try again';
                    btn.className = 'gps-btn error';
                    btn.disabled = false;
                    status.textContent = 'Error: ' + err.message;
                },
                { enableHighAccuracy: true, timeout: 10000 }
            );
        }

        function checkSubmit() {
            const building = document.getElementById('building').value.trim();
            const floor = document.getElementById('floor').value.trim();
            const ok = locationCaptured && building && floor !== '';
            document.getElementById('submitBtn').disabled = !ok;
        }

        document.getElementById('building').addEventListener('input', checkSubmit);
        document.getElementById('floor').addEventListener('input', checkSubmit);

        document.getElementById('locationForm').addEventListener('submit', function(e) {
            if (!locationCaptured) {
                e.preventDefault();
                document.getElementById('errorMsg').textContent = 'Please capture your GPS location first.';
            }
        });
    </script>
</body>
</html>`);
});

// POST /location/save  — save location & log user in
router.post('/save', async (req, res) => {
    const { token, latitude, longitude, building, floor, apartment, phone_country, phone_number } = req.body;
    const phone = ((phone_country || '') + (phone_number || '')).trim();

    // Log everything received so we can debug
    console.log('[Location] POST /save body:', {
        token: token ? token.slice(0, 20) + '...' : '(missing)',
        latitude,
        longitude,
        building,
        floor,
        apartment,
        phone,
    });

    if (!token) {
        return res.redirect(`${process.env.BC_STORE_URL}/login.php`);
    }

    let payload;
    try {
        payload = verify(token);
    } catch {
        return res.status(400).send('Session expired. Please <a href="/oauth/google/start">try again</a>.');
    }

    // Strict validation — all fields must be non-empty strings
    const missing = [];
    if (!latitude || latitude.trim() === '')   missing.push('latitude');
    if (!longitude || longitude.trim() === '') missing.push('longitude');
    if (!building || String(building).trim() === '')  missing.push('building');
    if (floor === undefined || floor === null || String(floor).trim() === '') missing.push('floor');
    if (!apartment || String(apartment).trim() === '') missing.push('apartment');
    if (!phone || phone.trim() === '') missing.push('phone');

    if (missing.length) {
        console.warn('[Location] Missing fields:', missing);
        return res.redirect(`${process.env.BC_LOCATION_PAGE_URL}?token=${encodeURIComponent(token)}&error=missing_fields`);
    }

    try {
        await Promise.all([
            saveCustomerLocation(payload.customerId, { latitude, longitude, building, floor, apartment, phone }),
            saveCustomerAddress(payload.customerId,  { latitude, longitude, building, floor, apartment, phone }),
        ]);
    } catch (err) {
        console.error('[Location] Failed to save location/address:', err.message);
        // Non-fatal — still log the user in
    }

    const loginJwt = buildLoginJwt(payload.customerId);
    res.redirect(`${process.env.BC_STORE_URL}/login/token/${loginJwt}`);
});

module.exports = router;
