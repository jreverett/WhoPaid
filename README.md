# WhoPaid

Receipt splitter app - upload a photo of your receipt, assign items to people, and send each person their share.

## Features

- **Receipt OCR** - Take or upload a photo of a receipt and automatically extract items and prices using Tesseract.js
- **Costco tax codes** - Handles tax code "A" (taxed) and "Z" (non-taxed) items with configurable tax rate
- **Split items** - Assign items to multiple people and automatically split the cost
- **Tax calculation** - Tax is calculated per-item and split proportionally
- **Send messages** - Generate and send pre-formed messages via WhatsApp, SMS, email, or copy to clipboard
- **GBP currency** - All prices displayed in British Pounds
- **Receipt-themed UI** - Paper-style design with torn edges, monospace fonts, and receipt aesthetics
- **No server required** - Runs entirely in the browser, hosted free on GitHub Pages

## Usage

1. Upload or photograph your receipt
2. Review and edit extracted items, prices, and tax codes
3. Add people and assign items to each person
4. View the summary and send each person their share

## Deployment

The app is automatically deployed to GitHub Pages when changes are pushed to the main branch. To enable:

1. Go to repository Settings > Pages
2. Under "Build and deployment", select "GitHub Actions" as the source
