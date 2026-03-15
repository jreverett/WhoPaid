const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

// Bot/crawler user-agent patterns that need OG tags
const CRAWLER_PATTERN =
  /bot|crawl|spider|slurp|facebookexternalhit|Facebot|Twitterbot|LinkedInBot|Slackbot|TelegramBot|Discordbot|iMessageBot|preview|embed|fetch|curl/i;

export default async function handler(request, context) {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/r\/([a-f0-9-]+)$/);

  if (!match) {
    return context.next();
  }

  const receiptId = match[1];
  const userAgent = request.headers.get("user-agent") || "";

  // Only intercept for crawlers/bots — real users get the SPA
  if (!CRAWLER_PATTERN.test(userAgent)) {
    return context.next();
  }

  // Fetch receipt data from the API
  try {
    const apiUrl = new URL(`/api/receipts/${receiptId}`, url.origin);
    const res = await fetch(apiUrl.toString());

    if (!res.ok) {
      return context.next();
    }

    const receipt = await res.json();
    const data = receipt.data;

    // Build a meaningful description from the receipt data
    const storeName = data.storeName || "WhoPaid?";
    const people = data.people || [];
    const items = data.items || [];
    const taxRate = (data.taxRate ?? 20) / 100;
    const totalAmount = items.reduce((sum, item) => sum + (item.price || 0), 0);
    const taxTotal = items
      .filter((item) => item.taxCode === "A")
      .reduce((sum, item) => sum + (item.price || 0) * taxRate, 0);
    const grandTotal = totalAmount + taxTotal;

    const personCount = people.length;
    const itemCount = items.length;

    const title = `WhoPaid — ${storeName}`;

    let descParts = [];
    if (itemCount > 0) {
      descParts.push(
        `${itemCount} item${itemCount !== 1 ? "s" : ""} · £${grandTotal.toFixed(2)} total`
      );
    }
    if (personCount > 0) {
      descParts.push(
        `Split between ${personCount} ${personCount === 1 ? "person" : "people"}`
      );
    }
    const description =
      descParts.length > 0
        ? descParts.join(" · ")
        : "View the receipt breakdown";

    // Use dynamic OG image for this specific receipt
    const ogImageUrl = new URL(`/api/og-image/${receiptId}`, url.origin).toString();
    const pageUrl = url.toString();

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:image" content="${ogImageUrl}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:url" content="${pageUrl}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <meta name="twitter:image" content="${ogImageUrl}">
  <meta http-equiv="refresh" content="0;url=${pageUrl}">
</head>
<body>
  <p>Redirecting to <a href="${pageUrl}">${escapeHtml(title)}</a>...</p>
</body>
</html>`;

    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  } catch {
    return context.next();
  }
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const config = {
  path: "/r/*",
};
