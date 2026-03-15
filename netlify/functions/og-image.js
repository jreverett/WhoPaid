import { createClient } from '@libsql/client';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

// Colors matching site CSS
const COLORS = {
    paper: '#faf9f6',
    ink: '#2c2c2c',
    inkLight: '#6b6b6b',
    inkFaint: '#a0a0a0',
    accent: '#d4380d',
    border: '#d9d8d4',
};

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

// Fetch a basic monospace font for the receipt look
async function loadFont() {
    // Use a simple approach - fetch a Google Font
    const response = await fetch(
        'https://fonts.gstatic.com/s/courierprime/v9/u-450q2lgwslOqpF_6gQ8kELWwZjW-Y.woff'
    );
    return await response.arrayBuffer();
}

function formatPrice(amount) {
    return '£' + Number(amount).toFixed(2);
}

export async function handler(event) {
    try {
        // Extract receipt ID from path: /api/og-image/:id
        const pathParts = event.path.split('/').filter(Boolean);
        const receiptId = pathParts.length > 2 ? pathParts[pathParts.length - 1] : null;

        if (!receiptId) {
            return {
                statusCode: 400,
                body: 'Missing receipt ID',
            };
        }

        // Fetch receipt data
        const client = getDb();
        const result = await client.execute({
            sql: 'SELECT data, created_at FROM receipts WHERE id = ?',
            args: [receiptId],
        });

        if (result.rows.length === 0) {
            // Return generic OG image for missing receipts
            return {
                statusCode: 302,
                headers: { Location: '/og-image.png' },
            };
        }

        const row = result.rows[0];
        const createdAt = Number(row.created_at);

        // Check if expired
        if (Date.now() - createdAt > FOURTEEN_DAYS_MS) {
            return {
                statusCode: 302,
                headers: { Location: '/og-image.png' },
            };
        }

        const data = JSON.parse(row.data);
        const { items = [], people = [], assignments = {}, taxRate = 20 } = data;

        // Calculate totals for each person
        const splits = people.map(person => {
            let personTotal = 0;
            items.forEach(item => {
                if (assignments[item.id]?.includes(person.id)) {
                    const splitCount = assignments[item.id].length;
                    const share = item.price / splitCount;
                    const tax = item.taxCode === 'A' ? share * (taxRate / 100) : 0;
                    personTotal += share + tax;
                }
            });
            return { name: person.name, amount: personTotal };
        });

        // Calculate grand total
        const grandTotal = items.reduce((sum, item) => {
            const tax = item.taxCode === 'A' ? item.price * (taxRate / 100) : 0;
            return sum + item.price + tax;
        }, 0);

        // Format date
        const date = new Date(createdAt);
        const dateStr = date.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' });

        // Store name - use first item or generic
        const storeName = data.storeName || 'Receipt';

        // Load font
        const fontData = await loadFont();

        // Generate SVG with Satori
        const svg = await satori(
            {
                type: 'div',
                props: {
                    style: {
                        width: '100%',
                        height: '100%',
                        display: 'flex',
                        flexDirection: 'column',
                        backgroundColor: COLORS.paper,
                        padding: '48px 60px',
                        fontFamily: 'Courier Prime',
                    },
                    children: [
                        // Top bar
                        {
                            type: 'div',
                            props: {
                                style: {
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    alignItems: 'center',
                                    marginBottom: '16px',
                                },
                                children: [
                                    {
                                        type: 'div',
                                        props: {
                                            style: { fontSize: '26px', color: COLORS.inkLight, fontWeight: 700 },
                                            children: 'WhoPaid',
                                        },
                                    },
                                    {
                                        type: 'div',
                                        props: {
                                            style: { fontSize: '13px', color: COLORS.accent, letterSpacing: '0.05em' },
                                            children: 'SHARED RECEIPT',
                                        },
                                    },
                                ],
                            },
                        },
                        // Dotted divider
                        {
                            type: 'div',
                            props: {
                                style: {
                                    borderBottom: `1px dashed ${COLORS.border}`,
                                    marginBottom: '32px',
                                },
                            },
                        },
                        // Main content
                        {
                            type: 'div',
                            props: {
                                style: {
                                    display: 'flex',
                                    flex: 1,
                                },
                                children: [
                                    // Left side
                                    {
                                        type: 'div',
                                        props: {
                                            style: {
                                                flex: 1,
                                                display: 'flex',
                                                flexDirection: 'column',
                                            },
                                            children: [
                                                // Store name
                                                {
                                                    type: 'div',
                                                    props: {
                                                        style: {
                                                            fontSize: '48px',
                                                            fontWeight: 700,
                                                            color: COLORS.ink,
                                                            marginBottom: '12px',
                                                        },
                                                        children: storeName,
                                                    },
                                                },
                                                // Date and people
                                                {
                                                    type: 'div',
                                                    props: {
                                                        style: {
                                                            fontSize: '17px',
                                                            color: COLORS.inkLight,
                                                            marginBottom: '40px',
                                                        },
                                                        children: `${dateStr} · ${people.length} people`,
                                                    },
                                                },
                                                // Total label
                                                {
                                                    type: 'div',
                                                    props: {
                                                        style: {
                                                            fontSize: '14px',
                                                            color: COLORS.inkFaint,
                                                            letterSpacing: '0.05em',
                                                            marginBottom: '4px',
                                                        },
                                                        children: 'TOTAL',
                                                    },
                                                },
                                                // Total amount
                                                {
                                                    type: 'div',
                                                    props: {
                                                        style: {
                                                            fontSize: '48px',
                                                            fontWeight: 700,
                                                            color: COLORS.accent,
                                                        },
                                                        children: formatPrice(grandTotal),
                                                    },
                                                },
                                            ],
                                        },
                                    },
                                    // Right side - split card
                                    {
                                        type: 'div',
                                        props: {
                                            style: {
                                                width: '520px',
                                                backgroundColor: COLORS.paper,
                                                border: `1px solid ${COLORS.border}`,
                                                borderRadius: '8px',
                                                padding: '24px',
                                            },
                                            children: splits.slice(0, 5).map((split, i) => ({
                                                type: 'div',
                                                props: {
                                                    style: {
                                                        display: 'flex',
                                                        justifyContent: 'space-between',
                                                        paddingBottom: i < Math.min(splits.length, 5) - 1 ? '16px' : '0',
                                                        marginBottom: i < Math.min(splits.length, 5) - 1 ? '16px' : '0',
                                                        borderBottom: i < Math.min(splits.length, 5) - 1 ? `1px dashed ${COLORS.border}` : 'none',
                                                    },
                                                    children: [
                                                        {
                                                            type: 'div',
                                                            props: {
                                                                style: { fontSize: '17px', color: COLORS.ink },
                                                                children: split.name,
                                                            },
                                                        },
                                                        {
                                                            type: 'div',
                                                            props: {
                                                                style: { fontSize: '17px', fontWeight: 700, color: COLORS.ink },
                                                                children: formatPrice(split.amount),
                                                            },
                                                        },
                                                    ],
                                                },
                                            })),
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                },
            },
            {
                width: 1200,
                height: 630,
                fonts: [
                    {
                        name: 'Courier Prime',
                        data: fontData,
                        weight: 400,
                        style: 'normal',
                    },
                    {
                        name: 'Courier Prime',
                        data: fontData,
                        weight: 700,
                        style: 'normal',
                    },
                ],
            }
        );

        // Convert SVG to PNG
        const resvg = new Resvg(svg, {
            fitTo: {
                mode: 'width',
                value: 1200,
            },
        });
        const pngData = resvg.render();
        const pngBuffer = pngData.asPng();

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'image/png',
                'Cache-Control': 'public, max-age=86400', // Cache for 1 day
            },
            body: pngBuffer.toString('base64'),
            isBase64Encoded: true,
        };
    } catch (error) {
        console.error('Error generating OG image:', error);
        // Fallback to static image
        return {
            statusCode: 302,
            headers: { Location: '/og-image.png' },
        };
    }
}
