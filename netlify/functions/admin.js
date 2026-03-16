import { createClient } from '@libsql/client';

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

export async function handler(event) {
    const headers = {
        'Content-Type': 'application/json',
    };

    // Verify admin secret
    const adminSecret = process.env.ADMIN_SECRET;
    if (!adminSecret) {
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Admin endpoint not configured' }),
        };
    }

    const authHeader = event.headers['authorization'] || '';
    const providedSecret = authHeader.replace('Bearer ', '');

    if (providedSecret !== adminSecret) {
        return {
            statusCode: 401,
            headers,
            body: JSON.stringify({ error: 'Unauthorized' }),
        };
    }

    // Parse the action from path: /api/admin/{action}
    const pathParts = event.path.split('/').filter(Boolean);
    const action = pathParts[pathParts.length - 1];

    try {
        await ensureTables();
        const client = getDb();

        // GET /api/admin/rate-limits - View current rate limits
        if (event.httpMethod === 'GET' && action === 'rate-limits') {
            const result = await client.execute('SELECT * FROM rate_limits ORDER BY key');
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ rateLimits: result.rows }),
            };
        }

        // GET /api/admin/errors - View recent errors
        if (event.httpMethod === 'GET' && action === 'errors') {
            const limit = parseInt(event.queryStringParameters?.limit) || 50;
            const result = await client.execute({
                sql: 'SELECT * FROM error_logs ORDER BY created_at DESC LIMIT ?',
                args: [limit],
            });
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ errors: result.rows }),
            };
        }

        // POST /api/admin/reset-rate-limit - Reset rate limits
        if (event.httpMethod === 'POST' && action === 'reset-rate-limit') {
            const body = JSON.parse(event.body || '{}');
            const { target } = body;

            let sql;
            let args = [];
            let message;

            switch (target) {
                case 'all':
                    sql = 'DELETE FROM rate_limits';
                    message = 'All rate limits reset';
                    break;
                case 'global':
                    sql = 'DELETE FROM rate_limits WHERE key = ?';
                    args = ['global'];
                    message = 'Global rate limit reset';
                    break;
                case 'all-ips':
                    sql = "DELETE FROM rate_limits WHERE key LIKE 'ip:%'";
                    message = 'All IP rate limits reset';
                    break;
                default:
                    if (target && target.startsWith('ip:')) {
                        sql = 'DELETE FROM rate_limits WHERE key = ?';
                        args = [target];
                        message = `Rate limit reset for ${target}`;
                    } else if (target && /^\d+\.\d+\.\d+\.\d+$/.test(target)) {
                        sql = 'DELETE FROM rate_limits WHERE key = ?';
                        args = [`ip:${target}`];
                        message = `Rate limit reset for IP ${target}`;
                    } else {
                        return {
                            statusCode: 400,
                            headers,
                            body: JSON.stringify({
                                error: 'Invalid target. Use: "all", "global", "all-ips", or an IP address',
                            }),
                        };
                    }
            }

            const result = await client.execute({ sql, args });
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ success: true, message, rowsAffected: result.rowsAffected }),
            };
        }

        // DELETE /api/admin/errors - Clear error logs
        if (event.httpMethod === 'DELETE' && action === 'errors') {
            const body = JSON.parse(event.body || '{}');
            const { olderThanDays } = body;

            let sql = 'DELETE FROM error_logs';
            let args = [];
            let message = 'All error logs cleared';

            if (olderThanDays) {
                const cutoff = new Date();
                cutoff.setDate(cutoff.getDate() - olderThanDays);
                sql = 'DELETE FROM error_logs WHERE created_at < ?';
                args = [cutoff.toISOString()];
                message = `Error logs older than ${olderThanDays} days cleared`;
            }

            const result = await client.execute({ sql, args });
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ success: true, message, rowsAffected: result.rowsAffected }),
            };
        }

        return {
            statusCode: 404,
            headers,
            body: JSON.stringify({ error: 'Unknown admin action' }),
        };

    } catch (error) {
        console.error('Admin error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Internal server error', details: error.message }),
        };
    }
}
