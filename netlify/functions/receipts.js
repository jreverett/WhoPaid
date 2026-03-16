import { createClient } from '@libsql/client';

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

let db = null;
let tablesInitialized = false;

function getDb() {
    if (!db) {
        db = createClient({
            url: process.env.TURSO_DATABASE_URL,
            authToken: process.env.TURSO_AUTH_TOKEN,
        });
    }
    return db;
}

async function ensureTables() {
    if (tablesInitialized) return;

    const client = getDb();
    await client.execute(`
        CREATE TABLE IF NOT EXISTS receipts (
            id TEXT PRIMARY KEY,
            data TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )
    `);
    await client.execute(`
        CREATE INDEX IF NOT EXISTS idx_receipts_created_at ON receipts(created_at)
    `);
    await client.execute(`
        CREATE TABLE IF NOT EXISTS receipt_images (
            receipt_id TEXT PRIMARY KEY,
            images TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )
    `);
    await client.execute(`
        CREATE INDEX IF NOT EXISTS idx_receipt_images_created_at ON receipt_images(created_at)
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

async function logError({ ip, errorType, message, stack, context }) {
    try {
        const client = getDb();
        await client.execute({
            sql: `INSERT INTO error_logs (created_at, ip_address, error_type, error_message, stack_trace, request_context)
                  VALUES (?, ?, ?, ?, ?, ?)`,
            args: [
                new Date().toISOString(),
                ip || 'unknown',
                errorType,
                message || null,
                stack || null,
                context ? JSON.stringify(context) : null,
            ],
        });
    } catch (e) {
        console.error('Failed to log error:', e);
    }
}

function getClientIP(event) {
    return event.headers['x-nf-client-connection-ip'] ||
           event.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
           event.headers['client-ip'] ||
           'unknown';
}

function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

async function cleanupExpired() {
    const client = getDb();
    const cutoff = Date.now() - FOURTEEN_DAYS_MS;
    await client.execute({
        sql: 'DELETE FROM receipts WHERE created_at < ?',
        args: [cutoff],
    });
    await client.execute({
        sql: 'DELETE FROM receipt_images WHERE created_at < ?',
        args: [cutoff],
    });
}

export async function handler(event) {
    const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Handle CORS preflight
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 204, headers };
    }

    const clientIP = getClientIP(event);

    try {
        await ensureTables();

        // Extract ID and action from path: /api/receipts/:id or /api/receipts/:id/images
        const pathParts = event.path.split('/').filter(Boolean);
        const lastPart = pathParts[pathParts.length - 1];
        const isImagesRequest = lastPart === 'images';
        const receiptId = isImagesRequest
            ? pathParts[pathParts.length - 2]
            : (pathParts.length > 2 ? lastPart : null);

        if (event.httpMethod === 'POST') {
            // Save new receipt
            const body = JSON.parse(event.body);
            const id = generateUUID();
            const createdAt = Date.now();

            // Extract images from body (don't store in DB)
            const { images, ...receiptData } = body;

            const client = getDb();
            await client.execute({
                sql: 'INSERT INTO receipts (id, data, created_at) VALUES (?, ?, ?)',
                args: [id, JSON.stringify({ ...receiptData, hasImages: !!images?.length }), createdAt],
            });

            // Store images in database if provided
            if (images && images.length > 0) {
                try {
                    await client.execute({
                        sql: 'INSERT INTO receipt_images (receipt_id, images, created_at) VALUES (?, ?, ?)',
                        args: [id, JSON.stringify(images), createdAt],
                    });
                } catch (imgError) {
                    console.error('Failed to store images:', imgError);
                    await logError({
                        ip: clientIP,
                        errorType: 'IMAGE_STORE_ERROR',
                        message: imgError.message,
                        stack: imgError.stack,
                        context: { receiptId: id, action: 'store-images', imageCount: images.length },
                    });
                    // Continue without images - receipt is still saved
                }
            }

            return {
                statusCode: 201,
                headers,
                body: JSON.stringify({ id }),
            };
        }

        // GET /api/receipts/:id/images - Fetch images for a receipt
        if (event.httpMethod === 'GET' && receiptId && isImagesRequest) {
            try {
                const client = getDb();
                const result = await client.execute({
                    sql: 'SELECT images, created_at FROM receipt_images WHERE receipt_id = ?',
                    args: [receiptId],
                });

                if (result.rows.length === 0) {
                    return {
                        statusCode: 404,
                        headers,
                        body: JSON.stringify({ error: 'No images found for this receipt' }),
                    };
                }

                const row = result.rows[0];
                const createdAt = Number(row.created_at);

                // Check if expired
                if (Date.now() - createdAt > FOURTEEN_DAYS_MS) {
                    // Clean up expired images
                    await client.execute({
                        sql: 'DELETE FROM receipt_images WHERE receipt_id = ?',
                        args: [receiptId],
                    });
                    return {
                        statusCode: 404,
                        headers,
                        body: JSON.stringify({ error: 'Images expired' }),
                    };
                }

                return {
                    statusCode: 200,
                    headers,
                    body: JSON.stringify({ images: JSON.parse(row.images) }),
                };
            } catch (error) {
                console.error('Error fetching images:', error);
                await logError({
                    ip: clientIP,
                    errorType: 'IMAGE_FETCH_ERROR',
                    message: error.message,
                    stack: error.stack,
                    context: { receiptId, action: 'fetch-images' },
                });
                return {
                    statusCode: 500,
                    headers,
                    body: JSON.stringify({ error: 'Failed to fetch images' }),
                };
            }
        }

        if (event.httpMethod === 'GET' && receiptId) {
            // Clean up expired receipts on read
            await cleanupExpired();

            const client = getDb();
            const result = await client.execute({
                sql: 'SELECT data, created_at FROM receipts WHERE id = ?',
                args: [receiptId],
            });

            if (result.rows.length === 0) {
                return {
                    statusCode: 404,
                    headers,
                    body: JSON.stringify({ error: 'Receipt not found or expired' }),
                };
            }

            const row = result.rows[0];
            const createdAt = Number(row.created_at);

            // Check if expired
            if (Date.now() - createdAt > FOURTEEN_DAYS_MS) {
                return {
                    statusCode: 404,
                    headers,
                    body: JSON.stringify({ error: 'Receipt expired' }),
                };
            }

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    id: receiptId,
                    data: JSON.parse(row.data),
                    createdAt,
                }),
            };
        }

        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'Invalid request' }),
        };
    } catch (error) {
        console.error('Error:', error);
        await logError({
            ip: clientIP,
            errorType: 'RECEIPTS_ERROR',
            message: error.message,
            stack: error.stack,
            context: { path: event.path, method: event.httpMethod },
        });
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Internal server error' }),
        };
    }
}
