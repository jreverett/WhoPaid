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

let tablesInitialized = false;

async function ensureTables() {
    if (tablesInitialized) return;

    const client = getDb();
    await client.execute(`
        CREATE TABLE IF NOT EXISTS rate_limits (
            key TEXT PRIMARY KEY,
            count INTEGER NOT NULL DEFAULT 0,
            reset_date TEXT NOT NULL
        )
    `);
    await client.execute(`
        CREATE TABLE IF NOT EXISTS error_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            ip_address TEXT,
            error_type TEXT NOT NULL,
            error_message TEXT,
            stack_trace TEXT,
            request_context TEXT,
            gemini_response TEXT
        )
    `);
    tablesInitialized = true;
}

async function logError({ ip, errorType, message, stack, context, geminiResponse }) {
    try {
        const client = getDb();
        await client.execute({
            sql: `INSERT INTO error_logs (created_at, ip_address, error_type, error_message, stack_trace, request_context, gemini_response)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`,
            args: [
                new Date().toISOString(),
                ip || 'unknown',
                errorType,
                message || null,
                stack || null,
                context ? JSON.stringify(context) : null,
                geminiResponse ? JSON.stringify(geminiResponse).substring(0, 10000) : null,
            ],
        });
    } catch (e) {
        // Don't let logging errors break the main flow
        console.error('Failed to log error:', e);
    }
}

// Map technical errors to user-friendly messages
function getFriendlyError(errorType, details) {
    const messages = {
        'GEMINI_API_ERROR': `The receipt couldn't be processed. ${details || 'Please try again.'}`,
        'GEMINI_BLOCKED': 'The image was blocked by safety filters. Please try a different image.',
        'GEMINI_QUOTA': 'The AI service is temporarily overloaded. Please try again in a few minutes.',
        'GEMINI_INVALID_IMAGE': 'The image format is not supported or the image is corrupted.',
        'GEMINI_TIMEOUT': 'The request took too long. Please try with a clearer image.',
        'PARSE_ERROR': 'Could not read the receipt. Please try a clearer photo.',
        'CONFIG_ERROR': 'Service is not properly configured. Please contact support.',
        'UNKNOWN': 'Something went wrong. Please try again.',
    };
    return messages[errorType] || messages['UNKNOWN'];
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

    const clientIP = getClientIP(event);

    // Wrap everything in try-catch to ensure errors are always logged
    try {
        await ensureTables();
    } catch (dbError) {
        console.error('Database initialization failed:', dbError);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Service temporarily unavailable. Please try again.' }),
        };
    }

    try {

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

        // Log request size for debugging
        const bodySize = event.body ? event.body.length : 0;
        const bodySizeKB = Math.round(bodySize / 1024);
        const bodySizeMB = (bodySize / (1024 * 1024)).toFixed(2);

        // Parse request body
        let body;
        try {
            body = JSON.parse(event.body);
        } catch (parseError) {
            await logError({
                ip: clientIP,
                errorType: 'PARSE_ERROR',
                message: `JSON parse failed: ${parseError.message}`,
                context: { bodySize, bodySizeKB, bodySizeMB, bodyPreview: event.body?.substring(0, 200) },
            });
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'Invalid request format' }),
            };
        }

        const { images } = body;

        if (!images || !Array.isArray(images) || images.length === 0) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'No images provided' }),
            };
        }

        // Log image info for debugging
        const imageInfo = images.map((img, i) => ({
            index: i,
            mimeType: img.mimeType,
            dataLength: img.data?.length || 0,
            dataSizeKB: Math.round((img.data?.length || 0) / 1024),
        }));

        console.log('Processing request:', { bodySizeMB, imageCount: images.length, imageInfo });

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

        const apiKey = process.env.GEMINI_KEY;
        if (!apiKey) {
            await logError({
                ip: clientIP,
                errorType: 'CONFIG_ERROR',
                message: 'GEMINI_KEY not configured',
                context: { imageCount: images.length },
            });
            return {
                statusCode: 500,
                headers,
                body: JSON.stringify({ error: getFriendlyError('CONFIG_ERROR') }),
            };
        }

        // Use AbortController for timeout (20 seconds, leaving buffer for logging)
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 20000);

        let response;
        try {
            response = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    signal: controller.signal,
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
                            temperature: 0,
                            maxOutputTokens: 8192,
                        },
                    }),
                }
            );
        } catch (fetchError) {
            clearTimeout(timeoutId);
            if (fetchError.name === 'AbortError') {
                await logError({
                    ip: clientIP,
                    errorType: 'GEMINI_TIMEOUT',
                    message: 'Gemini API request timed out after 20 seconds',
                    context: { imageCount: images.length, totalSizeKB: Math.round(bodySizeKB) },
                });
                return {
                    statusCode: 504,
                    headers,
                    body: JSON.stringify({ error: getFriendlyError('GEMINI_TIMEOUT') }),
                };
            }
            throw fetchError;
        }
        clearTimeout(timeoutId);

        if (!response.ok) {
            const errorBody = await response.json().catch(() => ({}));
            const errorMessage = errorBody.error?.message || `HTTP ${response.status}`;

            // Determine error type from response
            let errorType = 'GEMINI_API_ERROR';
            let details = null;

            if (response.status === 429 || errorMessage.includes('quota') || errorMessage.includes('rate')) {
                errorType = 'GEMINI_QUOTA';
            } else if (errorMessage.includes('safety') || errorMessage.includes('blocked')) {
                errorType = 'GEMINI_BLOCKED';
            } else if (errorMessage.includes('invalid') && errorMessage.includes('image')) {
                errorType = 'GEMINI_INVALID_IMAGE';
            } else if (response.status === 400) {
                details = 'The image may be too large or in an unsupported format.';
            }

            await logError({
                ip: clientIP,
                errorType,
                message: errorMessage,
                context: {
                    imageCount: images.length,
                    httpStatus: response.status,
                },
                geminiResponse: errorBody,
            });

            return {
                statusCode: 502,
                headers,
                body: JSON.stringify({ error: getFriendlyError(errorType, details) }),
            };
        }

        const data = await response.json();

        // Check for blocked content or empty response
        const candidate = data.candidates?.[0];
        if (!candidate) {
            const blockReason = data.promptFeedback?.blockReason;
            if (blockReason) {
                await logError({
                    ip: clientIP,
                    errorType: 'GEMINI_BLOCKED',
                    message: `Content blocked: ${blockReason}`,
                    context: { imageCount: images.length },
                    geminiResponse: data,
                });
                return {
                    statusCode: 400,
                    headers,
                    body: JSON.stringify({ error: getFriendlyError('GEMINI_BLOCKED') }),
                };
            }

            await logError({
                ip: clientIP,
                errorType: 'GEMINI_API_ERROR',
                message: 'No candidates in response',
                context: { imageCount: images.length },
                geminiResponse: data,
            });
            return {
                statusCode: 502,
                headers,
                body: JSON.stringify({ error: getFriendlyError('GEMINI_API_ERROR', 'No response from AI.') }),
            };
        }

        const text = candidate.content?.parts?.[0]?.text || '{}';

        // Parse the JSON response (handle potential markdown fences)
        let jsonStr = text.trim();
        if (jsonStr.startsWith('```')) {
            jsonStr = jsonStr.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
        }

        let result;
        try {
            result = JSON.parse(jsonStr);
        } catch (e) {
            await logError({
                ip: clientIP,
                errorType: 'PARSE_ERROR',
                message: e.message,
                stack: e.stack,
                context: { imageCount: images.length },
                geminiResponse: { rawText: text.substring(0, 2000) },
            });
            return {
                statusCode: 502,
                headers,
                body: JSON.stringify({ error: getFriendlyError('PARSE_ERROR') }),
            };
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

        // Get request body size for debugging
        const bodySize = event.body ? event.body.length : 0;

        await logError({
            ip: clientIP,
            errorType: 'UNKNOWN',
            message: error.message,
            stack: error.stack,
            context: {
                stage: 'handler',
                bodySize,
                bodySizeKB: Math.round(bodySize / 1024),
            },
        });

        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: getFriendlyError('UNKNOWN') }),
        };
    }
}
