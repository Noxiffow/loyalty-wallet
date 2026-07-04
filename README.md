# Loyalty Wallet

A production-ready digital loyalty card system for small businesses. Clients add a branded card to **Apple Wallet** or **Google Wallet** and receive stamps automatically — no app to download, no login required.

Built as a freelance project and deployed live for a real business client.

---

## Features

- **Apple Wallet & Google Wallet** — native pass generation, fully branded per business
- **Real-time push updates** — APNs (HTTP/2) for iOS, Google Wallet API PATCH for Android; cards update automatically without the client doing anything
- **Stamp tracking** — 10-stamp cycle with visual progress (custom stamp images embedded in the pass)
- **VIP expiry system** — automatic expiry detection, visual expired state on both platforms, email reminder via Resend 7 days before expiry
- **Admin panel PWA** — installable on iOS/Android home screen, protected by password, search clients, add stamps, edit data, delete cards
- **QR scan workflow** — each card has a unique QR; scanning from the admin panel identifies the client instantly
- **Email reminders** — transactional HTML email sent automatically when a VIP card is about to expire
- **Referral system** — clients get a unique invite link; referrals are tracked and linked to the referrer's card
- **Zero dependencies for push** — APNs implemented with Node.js native `http2`, no third-party APNs library

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js + Express |
| Database | SQLite (`better-sqlite3`) |
| Apple Wallet | `passkit-generator` + APNs HTTP/2 |
| Google Wallet | Google Wallet API + `google-auth-library` |
| Email | Resend |
| Deployment | Railway (volume-backed SQLite) |
| Admin UI | Vanilla JS PWA (no framework) |

---

## How It Works

```
Client receives invite link
        ↓
Fills name, phone, email → card created in DB
        ↓
Chooses Apple Wallet or Google Wallet → pass generated & downloaded
        ↓
Business scans QR from admin panel → adds stamp
        ↓
Card updates automatically on client's phone (APNs / Google Wallet API)
        ↓
At 10 stamps → cycle resets to 1
At VIP expiry → card visually expires, email reminder sent 7 days before
```

---

## Configuration

All business-specific settings are environment variables — no code changes needed to deploy for a new client.

```bash
cp .env.example .env
# Fill in your values
```

Key variables:

| Variable | Description |
|---|---|
| `BUSINESS_NAME` | Displayed on cards and emails |
| `BRAND_COLOR` | Hex color for card background |
| `BUSINESS_PHONE` / `BUSINESS_EMAIL` | Contact links on Google Wallet card |
| `BUSINESS_INSTAGRAM` / `BUSINESS_WEBSITE` | Social links on Google Wallet card |
| `APPLE_PASS_TYPE_ID` / `APPLE_TEAM_ID` | From Apple Developer portal |
| `APPLE_CERT_B64` / `APPLE_KEY_B64` / `APPLE_WWDR_B64` | Pass signing certs (base64) |
| `GOOGLE_ISSUER_ID` / `GOOGLE_CLASS_ID` | From Google Wallet Business Console |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` / `GOOGLE_PRIVATE_KEY` | Google service account |
| `RESEND_API_KEY` / `RESEND_FROM` | For expiry reminder emails |
| `ADMIN_PASSWORD` | Admin panel access |

See `.env.example` for the full list.

---

## Deployment

Designed for **Railway** with a persistent volume for SQLite, but works on any Node.js host.

```bash
npm install
node server.js
```

For Railway: set all env vars in the Railway dashboard, attach a volume at `/data`, and set `DB_PATH=/data/loyalty.db`.

---

## Apple Wallet Setup

1. Create a Pass Type ID at [developer.apple.com](https://developer.apple.com)
2. Generate and download the Pass Type certificate
3. Export certificate and private key as PEM from Keychain
4. Base64-encode the PEMs and set as `APPLE_CERT_B64`, `APPLE_KEY_B64`, `APPLE_WWDR_B64` in Railway env vars

---

## Service

This system is available as a **done-for-you freelance service** — including branding, deployment, and Apple/Google developer account setup.

Built by [Jonathan](https://nozutech.dev) · [nozutech.dev](https://nozutech.dev)
