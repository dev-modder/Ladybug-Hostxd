# 🐝 Ladybug-Mini Multi-Host Platform

**Version:** 2.0.0  
**Developer:** [Dev-Ntando](https://github.com/dev-modder)

A powerful multi-host dashboard for running multiple Ladybug-Mini WhatsApp bots on Render.com free tier. This hosting platform allows you to manage multiple bot sessions from a single beautiful dashboard, with real-time logs, automatic keep-alive pings, and auto-cleanup functionality.

---

## ✨ Features

### Multi-Host Dashboard
- **Multiple Sessions:** Run multiple WhatsApp bots from a single dashboard
- **Session Management:** Add, edit, and delete bot sessions through the UI
- **Individual Controls:** Start, stop, and restart each bot independently
- **Real-time Logs:** Live log streaming for all bots with WebSocket

### Render.com Optimized
- **Self-Ping Keep-Alive:** Prevents free tier from sleeping (configurable interval)
- **Auto Temp-File Cleanup:** Automatically removes old temporary files
- **Persistent Storage:** Session data persists across deploys
- **Health Check Endpoint:** Built-in `/health` endpoint for monitoring

### Dashboard Features
- **Beautiful UI:** Modern, dark-themed dashboard with animations
- **System Metrics:** Monitor memory, uptime, ping count, and cleanups
- **Bot Status Cards:** Visual cards for each bot session
- **Toast Notifications:** Real-time feedback for all actions

---

## 🚀 Deployment Guide

### Prerequisites
1. A [Render.com](https://render.com) account (free tier works!)
2. Your WhatsApp session string (from [Knight Bot Pair Code](https://knight-bot-paircode.onrender.com/))

### Step 1: Fork or Clone

Fork this repository to your GitHub account or clone it:

```bash
git clone https://github.com/YOUR_USERNAME/YOUR_REPO.git
cd YOUR_REPO
```

### Step 2: Create Web Service on Render

1. Go to [Render Dashboard](https://dashboard.render.com/)
2. Click **New** → **Web Service**
3. Connect your GitHub repository
4. Configure:
   - **Name:** `ladybug-mini-host` (or your preferred name)
   - **Runtime:** `Node`
   - **Build Command:** (leave empty - uses render.yaml)
   - **Start Command:** (leave empty - uses render.yaml)
   - **Plan:** `Free`

### Step 3: Set Environment Variables

In the Render dashboard, go to **Environment** tab and add:

| Variable | Required | Description |
|----------|----------|-------------|
| `RENDER_URL` | Yes | Your service URL (e.g., `https://ladybug-mini-host.onrender.com`) |
| `DASHBOARD_PIN` | No | Optional PIN to protect your dashboard |

### Step 4: Deploy

Click **Create Web Service** and wait for deployment to complete.

### Step 5: Access Dashboard

Visit your service URL to access the multi-host dashboard!

---

## 📖 Usage Guide

### Adding a New Bot Session

1. Click **"Add New Session"** button
2. Fill in the required fields:
   - **Owner Name:** Display name for the bot owner
   - **Session ID String:** Your KnightBot session string (e.g., `KnightBot!H4...`)
3. Optional settings:
   - **Owner WhatsApp Number:** Bot owner's number (without +)
   - **Bot Name:** Custom bot name
   - **Prefix:** Command prefix (default: `.`)
   - **Timezone:** Bot timezone
4. Click **Save Session**

### Managing Bot Sessions

- **Start:** Launch a bot session
- **Stop:** Stop a running bot
- **Restart:** Restart a bot
- **Edit:** Modify session settings
- **Delete:** Remove a session permanently

### Dashboard Controls

- **Add New Session:** Create a new bot session
- **Run Cleanup:** Manually trigger temp file cleanup

---

## 🔧 Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port (auto-set by Render) |
| `RENDER_URL` | - | Your Render service URL for keep-alive |
| `DASHBOARD_PIN` | - | Optional PIN for dashboard access |
| `BOT_NAME` | `Ladybug Bot Mini` | Default bot name |
| `PREFIX` | `.` | Default command prefix |
| `TIMEZONE` | `Asia/Kolkata` | Default timezone |
| `PING_INTERVAL` | `14` | Keep-alive ping interval (minutes) |
| `CLEANUP_INTERVAL` | `30` | Auto-cleanup interval (minutes) |
| `OPENAI_API_KEY` | - | OpenAI API key for AI features |
| `DEEPAI_API_KEY` | - | DeepAI API key |
| `REMOVE_BG_API_KEY` | - | Remove.bg API key |

---

## 📁 Project Structure

```
ladybug-mini-host/
├── server.js           # Main Express server with multi-host logic
├── package.json        # Node.js dependencies
├── render.yaml         # Render.com deployment config
├── .env.example        # Environment variables template
├── public/
│   └── index.html      # Multi-host dashboard UI
├── data/
│   └── sessions.json   # Persistent session storage
└── temp/               # Temporary files (auto-cleaned)
```

---

## 🔌 API Endpoints

### Session Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/sessions` | Get all sessions |
| `GET` | `/api/sessions/:id` | Get single session |
| `POST` | `/api/sessions` | Create new session |
| `PUT` | `/api/sessions/:id` | Update session |
| `DELETE` | `/api/sessions/:id` | Delete session |

### Bot Control

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/bot/start` | Start bot(s) |
| `POST` | `/api/bot/stop` | Stop bot(s) |
| `POST` | `/api/bot/restart` | Restart bot |
| `POST` | `/api/bot/cleanup` | Run cleanup |

### System

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/api/status` | Server status |
| `GET` | `/api/logs` | Get log history |

---

## 🛡️ Security

- Set `DASHBOARD_PIN` to protect your dashboard
- All sensitive actions require PIN authentication
- Session IDs are stored securely in the data directory
- Use HTTPS (automatic on Render.com)

---

## 🐛 Troubleshooting

### Bot Won't Start
- Check that your session ID is valid
- Verify the bot code is cloned correctly (check logs)
- Ensure all required environment variables are set

### Dashboard Not Loading
- Check server logs for errors
- Verify WebSocket connection in browser console
- Ensure RENDER_URL is set correctly

### Bot Crashes Repeatedly
- Check logs for error messages
- Verify session ID hasn't expired
- Try deleting and recreating the session

---

## 📜 Credits

- **Developer:** [Dev-Ntando](https://github.com/dev-modder)
- **Bot Source:** [Ladybug-Mini](https://github.com/dev-modder/Ladybug-Mini)
- **Baileys:** WhatsApp Web API library

---

## 📄 License

This project is open source and available under the MIT License.

---

## ⚠️ Disclaimer

This bot is created for educational purposes only. This is NOT an official WhatsApp bot. Using third-party bots may violate WhatsApp's Terms of Service and can lead to your account being banned. You use this bot at your own risk. The developers are not responsible for any bans, issues, or damages resulting from its use.

---

## 🤝 Support

For issues and feature requests, please open an issue on GitHub.

**Made with ❤️ by Dev-Ntando**
