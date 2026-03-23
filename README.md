# 🐝 LADYBUGNODES V(7)

**Version:** 7.0.0  
**Developer:** [Dev-Ntando](https://github.com/dev-modder)

The ultimate bot hosting platform with **ZiG and USD payments**, multi-auth sessions, per-bot logging, and support for WhatsApp, Telegram, Discord, and Slack bots.

---

## ✨ What's New in V(7)

### 💰 Payment System
- **ZiG (Zimbabwe Gold)** and **USD** payment support
- Multiple payment methods: Mobile Money, Bank Transfer, PayPal, Stripe
- Subscription-based hosting (paid plans required)
- Payment history and receipts

### 🤖 Multi-Platform Bot Support
- **WhatsApp** — Baileys, MD, Pairing Code
- **Telegram** — node-telegram-bot-api
- **Discord** — discord.js with slash commands
- **Slack** — Bolt SDK
- **Custom** — Your own bot code

### 🔐 Multi-Auth Session System
- `creds.json` — Baileys credentials
- `session_id` — String session / Pairing code
- `auth_state` — Multi-file auth state
- Auto-detection of session type

### 📋 Per-Bot Logging
- Individual log windows for each bot
- Real-time log streaming
- Log filtering and search
- Export to JSON, JSONL, text, CSV, HTML

### 📦 Subscription Plans

| Plan | Price (USD) | Price (ZiG) | Bots | Storage |
|------|-------------|-------------|------|---------|
| Starter | $5/mo | 161 ZiG/mo | 2 | 100MB |
| Pro | $15/mo | 484 ZiG/mo | 10 | 500MB |
| Enterprise | $50/mo | 1,613 ZiG/mo | 50 | 5GB |
| Unlimited | $100/mo | 3,225 ZiG/mo | ∞ | ∞ |

---

## 🚀 Deployment on Render.com

### Quick Deploy
1. Fork/Clone this repository
2. Go to [Render Dashboard](https://dashboard.render.com/)
3. Click **New → Web Service**
4. Connect your repository
5. Render auto-detects `render.yaml`
6. Set environment variables
7. Deploy!

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ADMIN_USERNAME` | ✅ | Admin username |
| `ADMIN_PASSWORD` | ✅ | Admin password |
| `JWT_SECRET` | ✅ | Secret for JWT tokens |
| `MONGODB_URI` | Optional | MongoDB connection string |

---

## 📁 Project Structure

```
ladybugnodes/
├── server.js              # Main server
├── routes/
│   ├── api.js            # API V2 routes
│   ├── botManager.js     # Bot management
│   └── payments.js       # Payment routes (ZiG/USD)
├── utils/
│   ├── botManager.js     # Bot lifecycle
│   ├── botLogger.js      # Per-bot logging
│   ├── sessionAuth.js    # Multi-auth sessions
│   ├── paymentSystem.js  # Payment logic
│   └── dataLayer.js      # Hybrid data layer
├── models/               # MongoDB models
├── public/
│   ├── index.html
│   ├── pricing.html      # Pricing page
│   ├── dashboard.html
│   └── ...
└── scripts/
    └── cleanup.js        # Daily cleanup
```

---

## 💳 Payment Methods

### ZiG Payments
- **Mobile Money** — Dial *123#
- **Bank Transfer** — Reserve Bank of Zimbabwe

### USD Payments
- **PayPal** — payments@ladybugnodes.com
- **Credit/Debit Card** — via Stripe
- **Bank Transfer** — Standard Chartered

---

## 🔧 API Endpoints

### Authentication
```
POST /api/signup          # Simple signup (no OTP)
POST /api/auth/signup     # Full signup (with OTP)
POST /api/login           # Login
```

### Payments
```
GET  /api/payments/plans           # Get pricing plans
GET  /api/payments/subscription    # Get user subscription
POST /api/payments/create          # Create payment
POST /api/payments/:id/confirm     # Confirm payment
GET  /api/payments/history         # Payment history
```

### Bots
```
GET  /api/panel-bots               # List bots
POST /api/panel-bots               # Create bot
POST /api/panel-bots/:id/start     # Start bot
POST /api/panel-bots/:id/stop      # Stop bot
GET  /api/v2/bots/:id/logs         # Get bot logs
```

---

## 🤖 Bot Templates

### WhatsApp Bot (Baileys)
```javascript
const { makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
// QR code authentication
```

### Telegram Bot
```javascript
const TelegramBot = require('node-telegram-bot-api');
const bot = new TelegramBot(token, { polling: true });
// Handle commands and messages
```

### Discord Bot
```javascript
const { Client, GatewayIntentBits } = require('discord.js');
const client = new Client({ intents: [...] });
// Slash commands and events
```

### Slack Bot
```javascript
const { App } = require('@slack/bolt');
const app = new App({ token, signingSecret });
// Events and commands
```

---

## 📄 License

MIT License

---

## 🙏 Credits

- Developer: [Dev-Ntando](https://github.com/dev-modder)
- WhatsApp: [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys)
- Telegram: [node-telegram-bot-api](https://github.com/yagop/node-telegram-bot-api)
- Discord: [discord.js](https://discord.js.org/)
- Slack: [@slack/bolt](https://api.slack.com/tools/bolt)