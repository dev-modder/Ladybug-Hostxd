# 🐝 LADYBUGNODES V5

**Multi-Host WhatsApp Bot Dashboard**

A powerful, self-hosted dashboard for managing multiple WhatsApp bot sessions with an intuitive web interface. Built with Node.js, Express, and modern web technologies.

---

## ✨ Version 5.0 Features

### 🔐 Enhanced Security
- **Two-Factor Authentication (2FA)** - TOTP-based 2FA support for secure logins
- **Rate Limiting** - Protection against brute-force attacks and API abuse
- **Account Lockout** - Automatic account lockout after failed login attempts
- **Security Headers** - Helmet.js integration for HTTP security headers
- **CORS Protection** - Configurable cross-origin resource sharing
- **Input Sanitization** - XSS protection for all user inputs

### 🗝️ API Key Management
- Generate, view, and revoke API keys
- External application integration support
- Secure API authentication

### 📋 Activity Logging & Audit Trail
- Comprehensive activity logs
- Track all user actions (login, logout, bot operations)
- Export logs to CSV
- Filter by type and search functionality

### 💾 Backup & Restore
- Manual backup creation
- Automatic scheduled backups
- Restore from backup files
- Data portability

### ⚙️ Settings Management
- Configurable coin cost per bot start
- Max sessions per user settings
- Auto-backup interval configuration
- Default bot prefix settings

### 🤖 Bot Templates
- Pre-configured bot templates
- Quick bot deployment
- Template management

### 📊 Dashboard Enhancements
- Real-time WebSocket updates
- Live log streaming
- System status monitoring
- User management for admins
- Coin balance tracking

---

## 🚀 Quick Start

### Prerequisites
- Node.js 18+ 
- npm or yarn

### Installation

```bash
# Clone the repository
git clone https://github.com/your-repo/ladybugnodes.git
cd ladybugnodes

# Install dependencies
npm install

# Start the server
npm start
```

The dashboard will be available at `http://localhost:3000`

### Default Credentials
- **Username:** `admin`
- **Password:** `admin123`

⚠️ **Important:** Change the default password immediately after first login!

---

## 📁 Project Structure

```
ladybugnodes/
├── server.js           # Main Express server
├── package.json        # Dependencies and scripts
├── public/             # Frontend files
│   ├── index.html      # Main dashboard
│   ├── login.html      # Login page with 2FA
│   ├── panel-bots.html # Bot management
│   ├── settings.html   # User settings
│   └── activity-logs.html  # Activity logs viewer
├── data/               # Data storage
│   ├── users.json      # User accounts
│   ├── sessions.json   # Bot sessions
│   ├── panel-bots.json # Uploaded bots
│   ├── activity-log.json # Audit trail
│   ├── settings.json   # App settings
│   ├── api-keys.json   # API key storage
│   ├── backups/        # Backup files
│   └── uploaded-bots/  # Bot ZIP files
└── node_modules/       # Dependencies
```

---

## 🔧 Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3000` |
| `NODE_ENV` | Environment mode | `development` |
| `JWT_SECRET` | JWT signing secret | (auto-generated) |

### Settings (Admin Only)

Configure these in the Settings page:

| Setting | Description | Default |
|---------|-------------|---------|
| Coin Cost per Start | Coins deducted per bot start | `5` |
| Max Sessions per User | Maximum bot sessions per user | `10` |
| Backup Interval | Hours between auto-backups | `24` |
| Max Login Attempts | Failed attempts before lockout | `5` |
| Default Prefix | Default bot command prefix | `.` |

---

## 📡 API Endpoints

### Authentication
```
POST /api/auth/login       # Login (supports 2FA)
POST /api/auth/register    # Create new user (admin only)
POST /api/auth/change-password  # Change password
POST /api/auth/2fa/setup   # Setup 2FA
POST /api/auth/2fa/enable  # Enable 2FA
POST /api/auth/2fa/verify  # Verify 2FA code
POST /api/auth/2fa/disable # Disable 2FA
GET  /api/auth/2fa/status  # Check 2FA status
```

### Sessions (Bot Management)
```
GET    /api/sessions       # List all sessions
POST   /api/sessions       # Create session
PUT    /api/sessions/:id   # Update session
DELETE /api/sessions/:id   # Delete session
POST   /api/bot/start      # Start a bot
POST   /api/bot/stop       # Stop a bot
POST   /api/bot/restart    # Restart a bot
POST   /api/bot/cleanup    # Run cleanup
```

### Panel Bots
```
GET    /api/panel-bots     # List uploaded bots
POST   /api/panel-bots     # Upload new bot
DELETE /api/panel-bots/:id # Delete bot
```

### API Keys
```
GET    /api/api-keys       # List API keys
POST   /api/api-keys       # Create API key
DELETE /api/api-keys/:id   # Delete API key
```

### Activity Logs
```
GET    /api/activity-log   # Get activity logs
POST   /api/activity-log/clear  # Clear old logs (admin)
```

### Backup & Restore
```
POST   /api/backup         # Create backup
GET    /api/backups        # List backups
POST   /api/restore/:file  # Restore from backup
```

### Settings
```
GET    /api/settings       # Get settings
POST   /api/settings       # Update settings (admin)
```

---

## 🔒 Security Best Practices

1. **Change Default Credentials** - Immediately change the admin password
2. **Enable 2FA** - Add an extra layer of security to your account
3. **Use HTTPS** - Deploy behind a reverse proxy with SSL
4. **Regular Backups** - Enable automatic backups
5. **API Key Rotation** - Regularly rotate API keys
6. **Monitor Logs** - Review activity logs for suspicious activity

---

## 🚢 Deployment

### Render.com (Recommended)

1. Connect your repository to Render
2. Create a new Web Service
3. Set build command: `npm install`
4. Set start command: `npm start`
5. Deploy!

### Docker

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
```

### Manual Deployment

```bash
npm ci --only=production
npm start
```

---

## 🔄 WebSocket Events

Real-time updates are sent via WebSocket:

| Event | Description |
|-------|-------------|
| `log` | Log entry |
| `bot:started` | Bot started |
| `bot:stopped` | Bot stopped |
| `bot:crashed` | Bot crashed |
| `ping` | Keep-alive ping |
| `cleanup` | Cleanup completed |
| `session_update` | Session status changed |

---

## 📝 License

MIT License - See LICENSE file for details.

---

## 🙏 Credits

- **Developer:** Dev-Ntando
- **Powered by:** Render.com
- **Built with:** Node.js, Express, WebSocket

---

## 🆘 Support

For issues and feature requests, please open an issue on GitHub.

**LADYBUGNODES V5** - Professional WhatsApp Bot Management