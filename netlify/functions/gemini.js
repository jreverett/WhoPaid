import { createClient } from '@libsql/client';

// Rate limits
const PER_IP_DAILY_LIMIT = 50;    // requests per IP per day
const GLOBAL_DAILY_LIMIT = 1000;  // total requests per day for all users

let db = null;

function getDb() {
    if (!db) {
        db = createClient({
            url: process.env.TURSO_DATABASE_URL,
            authToken: process.env.TURSO_AUTH_TOKEN,
        });
    }
    return db;
}

async function initRateLimitDb() {
    const client = getDb();
    await client.execute(`
        CREATE TABLE IF NOT EXISTS rate_limits (
            key TEXT PRIMARY KEY,
            count INTEGER NOT NULL DEFAULT 0,
            reset_date TEXT NOT NULL
        )
    `);
}

function getTodayDate() {
    return new Date().toISOString().split('T')[0]; // YYYY-MM-DD
}

async function checkAndIncrementRateLimit(key, limit) {
    const client = getDb();
    const today = getTodayDate();

    // Get current count for this key
    const result = await client.execute({
        sql: 'SELECT count, reset_date FROM rate_limits WHERE key = ?',
        args: [key],
    });

    let currentCount = 0;
    let needsReset = true;

    if (result.rows.length > 0) {
        const row = result.rows[0];
        if (row.reset_date === today) {
            currentCount = Number(row.count);
            needsReset = false;
        }
    }

    // Check if limit exceeded
    if (currentCount >= limit) {
        return { allowed: false, remaining: 0 };
    }

    // Increment or reset counter
    if (needsReset) {
        await client.execute({
            sql: `INSERT INTO rate_limits (key, count, reset_date)
                  VALUES (?, 1, ?)
                  ON CONFLICT(key) DO UPDATE SET count = 1, reset_date = ?`,
            args: [key, today, today],
        });
    } else {
        await client.execute({
            sql: 'UPDATE rate_limits SET count = count + 1 WHERE key = ?',
            args: [key],
        });
    }

    return { allowed: true, remaining: limit - currentCount - 1 };
}

function getClientIP(event) {
    // Netlify provides client IP in headers
    return event.headers['x-nf-client-connection-ip'] ||
           event.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
           event.headers['client-ip'] ||
           'unknown';
}

export async function handler(event) {
    const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Handle CORS preflight
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 204, headers };
    }

    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers,
            body: JSON.stringify({ error: 'Method not allowed' }),
        };
    }

    try {
        await initRateLimitDb();

        const clientIP = getClientIP(event);

        // Check global rate limit
        const globalCheck = await checkAndIncrementRateLimit('global', GLOBAL_DAILY_LIMIT);
        if (!globalCheck.allowed) {
            return {
                statusCode: 429,
                headers,
                body: JSON.stringify({
                    error: 'Service is temporarily at capacity. Please try again tomorrow.',
                    retryAfter: 'tomorrow',
                }),
            };
        }

        // Check per-IP rate limit
        const ipCheck = await checkAndIncrementRateLimit(`ip:${clientIP}`, PER_IP_DAILY_LIMIT);
        if (!ipCheck.allowed) {
            return {
                statusCode: 429,
                headers: {
                    ...headers,
                    'X-RateLimit-Remaining': '0',
                    'X-RateLimit-Reset': 'tomorrow',
                },
                body: JSON.stringify({
                    error: 'Daily limit reached. Please try again tomorrow.',
                    retryAfter: 'tomorrow',
                }),
            };
        }

        // Parse request body
        const body = JSON.parse(event.body);
        const { images } = body;

        if (!images || !Array.isArray(images) || images.length === 0) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'No images provided' }),
            };
        }

        // Build the Gemini API request
        const imageParts = images.map(img => ({
            inline_data: {
                mime_type: img.mimeType || 'image/jpeg',
                data: img.data,
            },
        }));

        const imageCount = images.length;
        const prompt = `You are a receipt parser. Analyze ${imageCount === 1 ? 'this receipt image' : `these ${imageCount} images of the same receipt`} and extract all purchased items.

${imageCount > 1 ? `IMPORTANT: These ${imageCount} images are photos of the SAME receipt, possibly:
- Overlapping (same items visible in multiple photos)
- Out of order (not photographed top-to-bottom)
- Capturing different sections of a long receipt

You must DEDUPLICATE items that appear in multiple images. Use item names, prices, and position context to identify duplicates.` : ''}

Return a JSON object with this exact format:
{
  "storeName": "STORE NAME",
  "hasTaxCodes": true,
  "serviceCharge": null,
  "items": [
    { "name": "PRODUCT NAME", "price": 12.99, "taxCode": "A" }
  ]
}

Fields:
- storeName: the store/restaurant/business name from the receipt header (max 30 characters)
- hasTaxCodes: true if receipt shows tax codes (like A/Z on Costco receipts), false otherwise
- serviceCharge: if this is a restaurant receipt with a service charge/gratuity, include the amount as a number. Otherwise null
- items: array of purchased items (DEDUPLICATED if multiple images)
  - name: Product name (max 60 characters)
  - price: Line total as a number (not unit price - use the final amount)
  - taxCode: "A" for taxed, "Z" for non-taxed. Only include if hasTaxCodes is true

Important:
- Extract ONLY purchased items
- EXCLUDE voided/refunded items
- EXCLUDE totals, subtotals, tax lines, payment methods, change, headers, dates, addresses
- EXCLUDE section headers like "Bottom of Basket", "BOB Count", etc.
- If an item GENUINELY appears multiple times on the receipt (customer bought 2 of same item as separate lines), include each
- But if the same item appears in multiple PHOTOS, only include it once
- Return ONLY the JSON object - no markdown fences, no explanation

If you cannot read any items, return: { "storeName": null, "hasTaxCodes": false, "serviceCharge": null, "items": [] }`;

        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            console.error('GEMINI_API_KEY not configured');
            return {
                statusCode: 500,
                headers,
                body: JSON.stringify({ error: 'Service not configured' }),
            };
        }

        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    contents: [
                        {
                            parts: [
                                { text: prompt },
                                ...imageParts,
                            ],
                        },
                    ],
                    generationConfig: {
                        temperature: 0.1,
                        maxOutputTokens: 8192,
                    },
                }),
            }
        );

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            console.error('Gemini API error:', error);
            return {
                statusCode: 502,
                headers,
                body: JSON.stringify({ error: 'Failed to process receipt' }),
            };
        }

        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';

        // Parse the JSON response (handle potential markdown fences)
        let jsonStr = text.trim();
        if (jsonStr.startsWith('```')) {
            jsonStr = jsonStr.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
        }

        let result;
        try {
            result = JSON.parse(jsonStr);
        } catch (e) {
            console.error('Failed to parse Gemini response:', jsonStr);
            result = { storeName: null, hasTaxCodes: false, serviceCharge: null, items: [] };
        }

        return {
            statusCode: 200,
            headers: {
                ...headers,
                'X-RateLimit-Remaining': String(ipCheck.remaining),
            },
            body: JSON.stringify(result),
        };

    } catch (error) {
        console.error('Error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Internal server error' }),
        };
    }
}
