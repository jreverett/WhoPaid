# WhoPaid

[![Netlify Status](https://api.netlify.com/api/v1/badges/e64c873d-5dbe-41b8-8fda-5c936ee0c0fb/deploy-status)](https://app.netlify.com/sites/who-paid/deploys)

Receipt splitter app - upload a photo of your receipt, assign items to people, and send each person their share.

## Features

- **Receipt OCR** - Take or upload a photo of a receipt and automatically extract items and prices using Gemini API
- **Costco tax codes** - Handles tax code "A" (taxed) and "Z" (non-taxed) items with configurable tax rate
- **Split items** - Assign items to multiple people and automatically split the cost
- **Tax calculation** - Tax is calculated per-item and split proportionally
- **Shareable receipts** - Receipts are saved and accessible via shareable URLs for 14 days
- **Send messages** - Generate and send pre-formed messages via WhatsApp, SMS, or copy to clipboard
- **GBP currency** - All prices displayed in British Pounds
- **Receipt-themed UI** - Paper-style design with torn edges, monospace fonts, and receipt aesthetics

## Usage

1. Upload or photograph your receipt
2. Review and edit extracted items, prices, and tax codes
3. Add people and assign items to each person
4. View the summary and send each person their share

## Deployment

The app is automatically deployed to Netlify when changes are pushed to the main branch.

### Environment Variables

Set these in your Netlify dashboard under Site settings > Environment variables:

- `TURSO_DATABASE_URL` - Your Turso database URL
- `TURSO_AUTH_TOKEN` - Your Turso auth token (generate with `turso db tokens create <db-name>`)
