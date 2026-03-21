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
const WHATSAPP_CONFIG = {
  senderNumber: process.env.WHATSAPP_SENDER_NUMBER || '2637868310191',
  apiUrl: process.env.WHATSAPP_API_URL || null,
  apiKey: process.env.WHATSAPP_API_KEY || null,
  senderSessionId: process.env.WHATSAPP_SENDER_SESSION || null,
};

// OTP Storage (in production, use Redis)
const otpStore = new Map();

// Graceful error handler
function handleError(context, error) {
  console.error(`[WA ERROR] ${context}:`, error.message);
  return { success: false, error: error.message, simulated: true };
}

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
  try {
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
  } catch (err) {
    return { valid: false, error: 'Verification error' };
  }
}

/**
 * Send WhatsApp message using external API
 * Supports multiple providers: Twilio, MessageBird, WhatsApp Business API, etc.
 */
async function sendViaAPI(to, message) {
  // If no API configured, simulate success (dev mode)
  if (!WHATSAPP_CONFIG.apiUrl || !WHATSAPP_CONFIG.apiKey) {
    console.log('[WA] No API configured - Development mode simulation');
    console.log(`[WA] To: ${to}`);
    console.log(`[WA] Message: ${message}`);
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
      }),
      timeout: 30000 // 30 second timeout
    });
    
    if (response.ok) {
      return { success: true };
    } else {
      const error = await response.text();
      return { success: false, error };
    }
  } catch (err) {
    return handleError('sendViaAPI', err);
  }
}

/**
 * Send WhatsApp message using callmebot API (free option)
 * https://www.callmebot.com/blog/free-api-whatsapp-messages/
 */
async function sendViaCallMeBot(to, message) {
  const callMeBotApi = process.env.CALLMEBOT_APIKEY;
  
  if (!callMeBotApi) {
    // Fall back to regular API or simulation
    return sendViaAPI(to, message);
  }
  
  try {
    const phone = to.replace(/[\+\s\-]/g, '');
    const encodedMsg = encodeURIComponent(message);
    const url = `https://api.callmebot.com/whatsapp.php?phone=${phone}&text=${encodedMsg}&apikey=${callMeBotApi}`;
    
    const response = await fetch(url, { timeout: 30000 });
    const text = await response.text();
    
    if (text.includes('invalid') || text.includes('error')) {
      console.log('[WA] CallMeBot error:', text);
      return { success: false, error: text };
    }
    
    return { success: true };
  } catch (err) {
    return handleError('sendViaCallMeBot', err);
  }
}

/**
 * Send WhatsApp message (main function)
 * Tries multiple methods in order
 */
async function sendWhatsAppMessage(to, message) {
  try {
    // Format phone number
    const formattedNumber = to.replace(/[\+\s\-]/g, '');
    
    // Try CallMeBot first (free), then regular API
    if (process.env.CALLMEBOT_APIKEY) {
      return await sendViaCallMeBot(formattedNumber, message);
    }
    
    return await sendViaAPI(formattedNumber, message);
  } catch (err) {
    console.log('[WA] Error sending message:', err.message);
    // In development, simulate success
    return { success: true, simulated: true };
  }
}

/**
 * Send verification OTP via WhatsApp
 */
async function sendVerificationOTP(phoneNumber) {
  try {
    const otp = generateOTP(6);
    storeOTP(phoneNumber, otp, 'verification');
    
    const message = `🔐 *LADYBUGNODES V(5)*\n\nYour verification code is: *${otp}*\n\nThis code will expire in 10 minutes.\n\nIf you didn't request this code, please ignore this message.`;
    
    const result = await sendWhatsAppMessage(phoneNumber, message);
    
    // Always return OTP in development for testing
    const isDev = process.env.NODE_ENV !== 'production';
    
    return {
      sent: result.success || result.simulated,
      otp: isDev || result.simulated ? otp : undefined,
      simulated: result.simulated || false,
      ...result
    };
  } catch (err) {
    handleError('sendVerificationOTP', err);
    // Generate OTP anyway for development
    const otp = generateOTP(6);
    storeOTP(phoneNumber, otp, 'verification');
    return { 
      sent: true, 
      otp: otp, 
      simulated: true,
      error: err.message 
    };
  }
}

/**
 * Send password reset OTP via WhatsApp
 */
async function sendPasswordResetOTP(phoneNumber) {
  try {
    const otp = generateOTP(6);
    storeOTP(phoneNumber, otp, 'password-reset');
    
    const message = `🔑 *LADYBUGNODES V(5)*\n\nYour password reset code is: *${otp}*\n\nThis code will expire in 10 minutes.\n\nIf you didn't request this reset, please secure your account.`;
    
    const result = await sendWhatsAppMessage(phoneNumber, message);
    
    const isDev = process.env.NODE_ENV !== 'production';
    
    return {
      sent: result.success || result.simulated,
      otp: isDev || result.simulated ? otp : undefined,
      simulated: result.simulated || false,
      ...result
    };
  } catch (err) {
    handleError('sendPasswordResetOTP', err);
    const otp = generateOTP(6);
    storeOTP(phoneNumber, otp, 'password-reset');
    return { 
      sent: true, 
      otp: otp, 
      simulated: true,
      error: err.message 
    };
  }
}

/**
 * Send 2FA OTP via WhatsApp
 */
async function send2FAOTP(phoneNumber) {
  try {
    const otp = generateOTP(6);
    storeOTP(phoneNumber, otp, '2fa');
    
    const message = `🔒 *LADYBUGNODES V(5)*\n\nYour 2FA code is: *${otp}*\n\nThis code will expire in 10 minutes.\n\nDo not share this code with anyone.`;
    
    const result = await sendWhatsAppMessage(phoneNumber, message);
    
    const isDev = process.env.NODE_ENV !== 'production';
    
    return {
      sent: result.success || result.simulated,
      otp: isDev || result.simulated ? otp : undefined,
      simulated: result.simulated || false,
      ...result
    };
  } catch (err) {
    handleError('send2FAOTP', err);
    const otp = generateOTP(6);
    storeOTP(phoneNumber, otp, '2fa');
    return { 
      sent: true, 
      otp: otp, 
      simulated: true,
      error: err.message 
    };
  }
}

/**
 * Send bot notification via WhatsApp
 */
async function sendBotNotification(phoneNumber, type, data) {
  let message = '';
  
  try {
    switch (type) {
      case 'bot_started':
        message = `✅ *LADYBUGNODES V(5)*\n\nYour bot "${data.botName}" has been started successfully.\n\nOwner: ${data.ownerName}\nPrefix: ${data.prefix || '!'}`;
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
    
    return await sendWhatsAppMessage(phoneNumber, message);
  } catch (err) {
    return handleError('sendBotNotification', err);
  }
}

/**
 * Send custom notification
 */
async function sendCustomNotification(phoneNumber, title, body) {
  try {
    const message = `📢 *${title}*\n\n${body}\n\n_LADYBUGNODES V(5)_`;
    return await sendWhatsAppMessage(phoneNumber, message);
  } catch (err) {
    return handleError('sendCustomNotification', err);
  }
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