# POS By Basit

POS By Basit is a desktop point-of-sale and inventory management application built with Electron. It includes sales, products, customers, suppliers, purchases, expenses, reporting, Urdu support, and receipt printing.

## Requirements

- Node.js 22 or newer
- npm
- A Firebase project configured for Authentication and Cloud Firestore

## Run locally

```bash
npm install
npm start
```

The application uses the Firebase web configuration in `app.js`. Firebase web configuration values are designed to be public, but production deployments must use strict Firebase Authentication and Firestore Security Rules.

## Offline support

After the app has loaded its data once while online, Firestore keeps a local cache in the Electron profile. Cached products, customers, suppliers, purchases, expenses, sales, and dashboard data remain available after a reload or restart without internet. Normal create, edit, and delete changes are saved locally and synchronized automatically when the connection returns. The header shows the current connection and sync state.

POS sales and Udhaar payments can also be recorded offline. They are stored in a durable local outbox, shown with a provisional reference, and synchronized through an idempotent Firestore transaction when internet returns. Firestore then assigns the final invoice number and validates stock and customer balances. If synchronization fails because stock or balance data changed elsewhere, the operation remains queued for review rather than being duplicated.

The first sign-in and first data load require internet. Offline sales depend on previously cached products and customers. Multiple devices should reconnect regularly so stock and customer balance conflicts are detected promptly.

## Build the Windows installer

```bash
npm run dist
```

The installer and unpacked application are written to `dist/`. Build output is intentionally ignored by Git.

## Project structure

- `index.js` - Electron main process and window setup
- `index.html` - Application interface
- `app.js` - Renderer logic and Firebase integration
- `style.css` - Application styles
- `assets/` - Application assets

## Notes

This project currently has no automated test suite. Test the main flows manually after launching the app, especially authentication, product management, sales, Firestore synchronization, and printing.
