/**
 * WhatsApp Notification & Verification Service
 * LADYBUGNODES V(5)
 * 
 * This service handles:
 * - OTP verification for signup
 * - Password reset via WhatsApp
 * - Bot notifications (start, stop, crash)
 * - Custom notifications to users
 */

const fetch = require('node-fetch');

// WhatsApp API Configuration
// Using the Baileys-based internal sender or external API
const WHATSAPP_CONFIG = {
  // Your WhatsApp number that will send messages
  senderNumber: process.env.WHATSAPP_SENDER_NUMBER || '2637868310191',
  // API endpoint for sending messages (can be configured for different providers)
  apiUrl: process.env.WHATSAPP_API_URL || null,
  apiKey: process.env.WHATSAPP_API_KEY || null,
  // Session ID for the sender bot (if using internal bot)
  senderSessionId: process.env.WHATSAPP_SENDER_SESSION || null,
};

// OTP Storage (in production, use Redis)
const otpStore = new Map();

/**
 * Generate a random OTP code
 */
function generateOTP(length = 6) {
  return Math.floor(Math.random() * Math.pow(10, length))
    .toString()
    .padStart(length, '0');
}

/**
 * Store OTP for verification
 */
function storeOTP(phoneNumber, otp, type = 'verification') {
  const key = `${phoneNumber}:${type}`;
  otpStore.set(key, {
    otp,
    createdAt: Date.now(),
    attempts: 0,
    verified: false
  });
  
  // Auto-expire after 10 minutes
  setTimeout(() => {
    otpStore.delete(key);
  }, 10 * 60 * 1000);
  
  return otp;
}

/**
 * Verify OTP
 */
function verifyOTP(phoneNumber, otp, type = 'verification') {
  const key = `${phoneNumber}:${type}`;
  const stored = otpStore.get(key);
  
  if (!stored) {
    return { valid: false, error: 'OTP expired or not found' };
  }
  
  if (stored.attempts >= 3) {
    otpStore.delete(key);
    return { valid: false, error: 'Too many attempts. Please request a new OTP.' };
  }
  
  if (Date.now() - stored.createdAt > 10 * 60 * 1000) {
    otpStore.delete(key);
    return { valid: false, error: 'OTP has expired' };
  }
  
  stored.attempts++;
  
  if (stored.otp !== otp) {
    return { valid: false, error: 'Invalid OTP' };
  }
  
  stored.verified = true;
  otpStore.delete(key);
  
  return { valid: true };
}

/**
 * Send WhatsApp message using internal bot
 */
async function sendViaInternalBot(to, message) {
  // This function sends a message through the internal bot system
  // It requires a running bot session with the sender number
  
  const { state } = require('../server');
  const senderProcess = state.botProcesses[WHATSAPP_CONFIG.senderSessionId];
  
  if (!senderProcess) {
    console.log('[WA] Sender bot not running. Falling back to log.');
    console.log(`[WA] To: ${to}\n[WA] Message: ${message}`);
    return { success: false, error: 'Sender bot not running' };
  }
  
  // Send message through bot's IPC or HTTP endpoint
  // This depends on your bot's implementation
  try {
    // If your bot exposes an HTTP API for sending messages
    const response = await fetch(`http://localhost:${process.env.BOT_API_PORT || 4000}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, message })
    });
    
    return { success: response.ok };
  } catch (err) {
    console.log(`[WA] Failed to send message: ${err.message}`);
    console.log(`[WA] To: ${to}\n[WA] Message: ${message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Send WhatsApp message using external API (like Twilio, MessageBird, etc.)
 */
async function sendViaAPI(to, message) {
  if (!WHATSAPP_CONFIG.apiUrl || !WHATSAPP_CONFIG.apiKey) {
    console.log('[WA] No API configured. Logging message:');
    console.log(`[WA] To: ${to}\n[WA] Message: ${message}`);
    return { success: true, simulated: true };
  }
  
  try {
    const response = await fetch(WHATSAPP_CONFIG.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${WHATSAPP_CONFIG.apiKey}`
      },
      body: JSON.stringify({
        to: to.startsWith('+') ? to : `+${to}`,
        message,
        from: WHATSAPP_CONFIG.senderNumber
      })
    });
    
    if (response.ok) {
      return { success: true };
    } else {
      const error = await response.text();
      return { success: false, error };
    }
  } catch (err) {
    console.log(`[WA] API Error: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Send WhatsApp message (main function)
 */
async function sendWhatsAppMessage(to, message) {
  // Format phone number (remove +, spaces, dashes)
  const formattedNumber = to.replace(/[\+\s\-]/g, '');
  
  // Try internal bot first, then external API
  if (WHATSAPP_CONFIG.senderSessionId) {
    return sendViaInternalBot(formattedNumber, message);
  }
  
  return sendViaAPI(formattedNumber, message);
}

/**
 * Send verification OTP via WhatsApp
 */
async function sendVerificationOTP(phoneNumber) {
  const otp = generateOTP(6);
  storeOTP(phoneNumber, otp, 'verification');
  
  const message = `🔐 *LADYBUGNODES V(5)*\n\nYour verification code is: *${otp}*\n\nThis code will expire in 10 minutes.\n\nIf you didn't request this code, please ignore this message.`;
  
  const result = await sendWhatsAppMessage(phoneNumber, message);
  
  return {
    sent: result.success,
    otp: process.env.NODE_ENV === 'development' ? otp : undefined, // Only show in dev
    ...result
  };
}

/**
 * Send password reset OTP via WhatsApp
 */
async function sendPasswordResetOTP(phoneNumber) {
  const otp = generateOTP(6);
  storeOTP(phoneNumber, otp, 'password-reset');
  
  const message = `🔑 *LADYBUGNODES V(5)*\n\nYour password reset code is: *${otp}*\n\nThis code will expire in 10 minutes.\n\nIf you didn't request this reset, please secure your account.`;
  
  const result = await sendWhatsAppMessage(phoneNumber, message);
  
  return {
    sent: result.success,
    otp: process.env.NODE_ENV === 'development' ? otp : undefined,
    ...result
  };
}

/**
 * Send 2FA OTP via WhatsApp
 */
async function send2FAOTP(phoneNumber) {
  const otp = generateOTP(6);
  storeOTP(phoneNumber, otp, '2fa');
  
  const message = `🔒 *LADYBUGNODES V(5)*\n\nYour 2FA code is: *${otp}*\n\nThis code will expire in 10 minutes.\n\nDo not share this code with anyone.`;
  
  const result = await sendWhatsAppMessage(phoneNumber, message);
  
  return {
    sent: result.success,
    otp: process.env.NODE_ENV === 'development' ? otp : undefined,
    ...result
  };
}

/**
 * Send bot notification via WhatsApp
 */
async function sendBotNotification(phoneNumber, type, data) {
  let message = '';
  
  switch (type) {
    case 'bot_started':
      message = `✅ *LADYBUGNODES V(5)*\n\nYour bot "${data.botName}" has been started successfully.\n\nOwner: ${data.ownerName}\nPrefix: ${data.prefix}`;
      break;
      
    case 'bot_stopped':
      message = `⏹️ *LADYBUGNODES V(5)*\n\nYour bot "${data.botName}" has been stopped.\n\nOwner: ${data.ownerName}`;
      break;
      
    case 'bot_crashed':
      message = `❌ *LADYBUGNODES V(5)*\n\nYour bot "${data.botName}" has crashed!\n\nPlease check the logs in your dashboard.\n\nOwner: ${data.ownerName}`;
      break;
      
    case 'coins_low':
      message = `⚠️ *LADYBUGNODES V(5)*\n\nYour coin balance is running low!\n\nCurrent balance: ${data.coins} coins\n\nTop up to keep your bots running.`;
      break;
      
    case 'coins_added':
      message = `💰 *LADYBUGNODES V(5)*\n\n${data.amount} coins have been added to your account.\n\nNew balance: ${data.coins} coins`;
      break;
      
    case 'session_created':
      message = `🆕 *LADYBUGNODES V(5)*\n\nNew session created!\n\nBot: ${data.botName}\nOwner: ${data.ownerName}`;
      break;
      
    default:
      message = `📢 *LADYBUGNODES V(5)*\n\n${data.message || 'You have a new notification.'}`;
  }
  
  return sendWhatsAppMessage(phoneNumber, message);
}

/**
 * Send custom notification
 */
async function sendCustomNotification(phoneNumber, title, body) {
  const message = `📢 *${title}*\n\n${body}\n\n_LADYBUGNODES V(5)_`;
  return sendWhatsAppMessage(phoneNumber, message);
}

// Export all functions
module.exports = {
  generateOTP,
  storeOTP,
  verifyOTP,
  sendWhatsAppMessage,
  sendVerificationOTP,
  sendPasswordResetOTP,
  send2FAOTP,
  sendBotNotification,
  sendCustomNotification,
  WHATSAPP_CONFIG
};