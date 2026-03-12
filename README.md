# 🐞 Ladybug-Mini Hosting Platform

A production-grade, Render.com–optimized hosting server for the [Ladybug-Mini WhatsApp Bot](https://github.com/dev-modder/Ladybug-Mini).

---

## ✨ Features

| Feature | Details |
|---|---|
| **Keep-alive ping** | Pings itself every 14 min so Render free tier never sleeps |
| **Auto temp cleanup** | Deletes files older than 15 min from all temp dirs every 30 min |
| **Real-time dashboard** | Beautiful live-updating status UI via WebSocket |
| **Bot process manager** | Start / Stop / Restart bot from the dashboard |
| **Auto crash recovery** | Bot restarts automatically after a crash |
| **Health endpoint** | `/health` JSON endpoint for Render's health check |
| **Log streaming** | 500-line circular log buffer streamed live to dashboard |
| **System metrics** | RAM, uptime, load avg, cleanup & ping counts |

---

## 🚀 Deploy to Render (Free Tier)

### Step 1 — Fork this repo
Push this folder to a **new GitHub repo** (e.g. `ladybug-mini-host`).

```bash
cd ladybug-mini-host
git init && git add . && git commit -m "initial"
git remote add origin https://github.com/YOUR_USERNAME/ladybug-mini-host.git
git push -u origin main
```

### Step 2 — Create a Render Web Service
1. Go to [dashboard.render.com](https://dashboard.render.com) → **New → Web Service**
2. Connect your GitHub repo `ladybug-mini-host`
3. Render will detect `render.yaml` automatically

### Step 3 — Set Environment Variables
In Render → your service → **Environment**, add:

| Variable | Value |
|---|---|
| `SESSION_ID` | Your `KnightBot!H4...` session string |
| `OWNER_NUMBER` | Your WhatsApp number (no `+`) |
| `RENDER_URL` | `https://your-service-name.onrender.com` |
| `BOT_NAME` | `Ladybug Bot Mini` |
| `PREFIX` | `.` |
| `TIMEZONE` | `Asia/Kolkata` |
| `PING_INTERVAL` | `14` |
| `CLEANUP_INTERVAL` | `30` |
| `DASHBOARD_PIN` | *(optional — protects dashboard)* |
| `OPENAI_API_KEY` | *(optional)* |

### Step 4 — Deploy
Click **Deploy** and watch the logs. The dashboard will be live at your Render URL.

---

## 📁 Directory Structure

```
ladybug-mini-host/
├── server.js          ← Main hosting server
├── package.json
├── render.yaml        ← Render deployment config
├── .env.example       ← Environment template
├── .gitignore
├── public/
│   └── index.html     ← Dashboard UI
└── temp/              ← Auto-created temp dir (auto-cleaned)
```

The build step clones the bot next to this folder:
```
parent/
├── ladybug-mini-host/   ← this repo
└── Ladybug-Mini/        ← bot (cloned during build)
```

---

## 🧹 Auto Cleanup

- Runs every **30 minutes** (configurable via `CLEANUP_INTERVAL`)
- Scans: `os.tmpdir()`, `./temp`, `../Ladybug-Mini/temp`, `../Ladybug-Mini/tmp`, `../Ladybug-Mini/downloads`
- Deletes files **older than 15 minutes**
- Triggered manually via dashboard button or `POST /api/bot/cleanup`

---

## 🔌 API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check (status, uptime) |
| `GET` | `/api/status` | Full system status JSON |
| `GET` | `/api/logs` | Log buffer JSON |
| `POST` | `/api/bot/start` | Start the bot |
| `POST` | `/api/bot/stop` | Stop the bot |
| `POST` | `/api/bot/restart` | Restart the bot |
| `POST` | `/api/bot/cleanup` | Trigger manual cleanup |

Protected by `x-dashboard-pin` header if `DASHBOARD_PIN` is set.

---

## ⚠️ Notes

- Render **free tier** instances sleep after 15 min of inactivity. The self-ping at 14-min intervals prevents this.
- If the bot entry point is not found, the server runs in **dashboard-only mode** and logs a warning.
- WhatsApp bots may violate WhatsApp ToS. Use at your own risk.

---

## 📄 License
MIT — same as Ladybug-Mini.
