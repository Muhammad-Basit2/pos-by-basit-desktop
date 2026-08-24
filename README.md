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
