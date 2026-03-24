const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const qrcode = require('qrcode');

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 8080;
const SESSION_NAME = process.env.SESSION_NAME || 'default';
const API_KEY = process.env.API_KEY || '';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const AUTH_DIR = './auth_state';

let sock = null;
let qrCode = null;
let connectionStatus = 'disconnected';
let lastError = null;

// In-memory stores
const contactStore = {};
const chatStore = {};
const messageStore = {};

// API key middleware
if (API_KEY) {
  app.use((req, res, next) => {
    if (req.path === '/health') return next();
    const key = req.headers['x-api-key'] || req.query.api_key;
    if (key !== API_KEY) return res.status(401).json({ error: 'Invalid API key' });
    next();
  });
}

// Webhook helper
async function sendWebhook(event, data) {
  if (!WEBHOOK_URL) return;
  try {
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, session: SESSION_NAME, data, timestamp: Date.now() }),
    });
  } catch (e) {
    console.error('Webhook error:', e.message);
  }
}

// Start Baileys connection
async function startConnection() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: 'silent' }),
    browser: [SESSION_NAME, 'Chrome', '120.0.0'],
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 0,
    keepAliveIntervalMs: 30000,
    emitOwnEvents: true,
    generateHighQualityLinkPreview: false,
  });

  // Connection updates
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      qrCode = await qrcode.toDataURL(qr);
      connectionStatus = 'waiting_for_qr';
      console.log('QR code generated');
    }
    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      lastError = lastDisconnect?.error?.message || 'Unknown';
      console.log('Connection closed. Reason:', reason, lastError);
      if (reason === DisconnectReason.loggedOut) {
        connectionStatus = 'logged_out';
        console.log('Logged out. Clearing session...');
        if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true });
        setTimeout(startConnection, 3000);
      } else {
        connectionStatus = 'reconnecting';
        setTimeout(startConnection, 3000);
      }
      sendWebhook('connection.closed', { reason, error: lastError });
    }
    if (connection === 'open') {
      connectionStatus = 'connected';
      qrCode = null;
      lastError = null;
      console.log('Connected successfully!');
      sendWebhook('connection.open', { session: SESSION_NAME });
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // Contacts
  sock.ev.on('contacts.upsert', (contacts) => {
    for (const c of contacts) {
      contactStore[c.id] = {
        wa_id: c.id,
        name: c.name || c.notify || c.verifiedName || null,
        notify: c.notify || null,
      };
    }
    console.log(`Contacts updated: ${contacts.length}`);
  });

  sock.ev.on('contacts.update', (updates) => {
    for (const u of updates) {
      if (contactStore[u.id]) {
        Object.assign(contactStore[u.id], u);
      }
    }
  });

  // Chats
  sock.ev.on('chats.upsert', (chats) => {
    for (const c of chats) {
      chatStore[c.id] = {
        ...chatStore[c.id],
        ...c,
        wa_id: c.id,
        is_group: c.id.endsWith('@g.us'),
      };
    }
  });

  sock.ev.on('chats.update', (updates) => {
    for (const u of updates) {
      if (chatStore[u.id]) {
        Object.assign(chatStore[u.id], u);
      } else {
        chatStore[u.id] = { ...u, wa_id: u.id, is_group: u.id.endsWith('@g.us') };
      }
    }
  });

  // Messages
  sock.ev.on('messages.upsert', async ({ messages: msgs, type }) => {
    for (const msg of msgs) {
      const chatId = msg.key.remoteJid;
      if (!chatId) continue;

      if (!messageStore[chatId]) messageStore[chatId] = [];
      messageStore[chatId].push(msg);
      if (messageStore[chatId].length > 500) {
        messageStore[chatId] = messageStore[chatId].slice(-300);
      }

      // Update chat with last message time
      chatStore[chatId] = {
        ...chatStore[chatId],
        wa_id: chatId,
        is_group: chatId.endsWith('@g.us'),
        last_message_time: msg.messageTimestamp || Math.floor(Date.now() / 1000),
      };

      // Forward to webhook
      if (type === 'notify' && !msg.key.fromMe) {
        const body = msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.videoMessage?.caption ||
          '';
        sendWebhook('message', {
          chatId,
          messageId: msg.key.id,
          body,
          fromMe: false,
          sender: msg.key.participant || chatId,
          pushName: msg.pushName || null,
          timestamp: msg.messageTimestamp,
          hasMedia: !!(msg.message?.imageMessage || msg.message?.videoMessage || msg.message?.audioMessage || msg.message?.documentMessage),
        });
      }
    }
  });

  // Groups
  sock.ev.on('groups.upsert', (groups) => {
    for (const g of groups) {
      chatStore[g.id] = { ...chatStore[g.id], ...g, wa_id: g.id, is_group: true };
    }
  });

  sock.ev.on('groups.update', (updates) => {
    for (const u of updates) {
      if (chatStore[u.id]) Object.assign(chatStore[u.id], u);
    }
  });
}

// ─── Routes ───

app.get('/health', (req, res) => {
  const checks = {
    baileys: !!makeWASocket,
    express: true,
    session_name: !!SESSION_NAME,
    api_key_set: !!API_KEY,
    webhook_url_set: !!WEBHOOK_URL,
    connection_status: connectionStatus,
  };
  res.json({ status: 'ok', checks });
});

app.get('/status', (req, res) => {
  res.json({
    status: connectionStatus,
    session: SESSION_NAME,
    error: lastError,
    has_qr: !!qrCode,
    contacts_count: Object.keys(contactStore).length,
    chats_count: Object.keys(chatStore).length,
  });
});

app.get('/qr', (req, res) => {
  if (!qrCode) return res.json({ qr: null, status: connectionStatus });
  res.json({ qr: qrCode, status: connectionStatus });
});

app.get('/contacts', (req, res) => {
  const contacts = Object.values(contactStore).map((c) => ({
    wa_id: c.wa_id,
    name: c.name || c.notify || c.wa_id.replace('@s.whatsapp.net', ''),
    phone: c.wa_id.replace('@s.whatsapp.net', ''),
    is_business: false,
  }));
  res.json({ contacts });
});

app.get('/groups', async (req, res) => {
  try {
    const groups = await sock?.groupFetchAllParticipating();
    const list = groups
      ? Object.values(groups).map((g) => ({
          wa_id: g.id,
          name: g.subject || g.id,
          description: g.desc || null,
          member_count: g.participants?.length || 0,
          participants: g.participants || [],
        }))
      : [];
    res.json({ groups: list });
  } catch (e) {
    // Fallback to in-memory
    const list = Object.values(chatStore)
      .filter((c) => c.is_group)
      .map((c) => ({
        wa_id: c.wa_id,
        name: c.subject || c.name || c.wa_id,
        description: c.desc || null,
        member_count: 0,
      }));
    res.json({ groups: list });
  }
});

app.get('/chats', (req, res) => {
  const chats = Object.values(chatStore)
    .map((c) => ({
      wa_id: c.wa_id || c.id,
      id: c.wa_id || c.id,
      name: c.subject || c.name || contactStore[c.wa_id || c.id]?.name || (c.wa_id || c.id).replace('@s.whatsapp.net', '').replace('@g.us', ''),
      is_group: c.is_group || (c.wa_id || c.id || '').endsWith('@g.us'),
      unread_count: c.unreadCount || 0,
      last_message_time: c.last_message_time || c.conversationTimestamp || 0,
    }))
    .sort((a, b) => (b.last_message_time || 0) - (a.last_message_time || 0));
  res.json({ chats });
});

app.get('/messages/:chatId', async (req, res) => {
  const chatId = decodeURIComponent(req.params.chatId);
  const limit = parseInt(req.query.limit) || 50;
  const before = req.query.before ? parseInt(req.query.before) : null;

  let msgs = messageStore[chatId] || [];

  if (before) {
    msgs = msgs.filter((m) => {
      const ts = typeof m.messageTimestamp === 'object' ? m.messageTimestamp.low : Number(m.messageTimestamp);
      return ts < before;
    });
  }

  const sliced = msgs.slice(-limit);
  const formatted = sliced.map((m) => {
    const ts = typeof m.messageTimestamp === 'object' ? m.messageTimestamp.low : Number(m.messageTimestamp);
    return {
      wa_message_id: m.key.id,
      id: m.key.id,
      body: m.message?.conversation ||
        m.message?.extendedTextMessage?.text ||
        m.message?.imageMessage?.caption ||
        m.message?.videoMessage?.caption ||
        '',
      fromMe: m.key.fromMe || false,
      timestamp: ts,
      sender: m.key.participant || m.pushName || null,
      hasMedia: !!(m.message?.imageMessage || m.message?.videoMessage || m.message?.audioMessage || m.message?.documentMessage),
    };
  });

  res.json({
    messages: formatted,
    has_more: msgs.length > sliced.length,
  });
});

app.get('/groups/:groupId/participants', async (req, res) => {
  const groupId = decodeURIComponent(req.params.groupId);
  try {
    const meta = await sock.groupMetadata(groupId);
    res.json({
      participants: meta.participants.map((p) => ({
        wa_id: p.id,
        admin: p.admin || null,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/send', async (req, res) => {
  if (!sock) return res.status(503).json({ error: 'Client not ready' });
  const { chatId, message } = req.body;
  if (!chatId || !message) return res.status(400).json({ error: 'chatId and message required' });
  try {
    const sent = await sock.sendMessage(chatId, { text: message });
    res.json({ success: true, id: sent?.key?.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/send-media', async (req, res) => {
  if (!sock) return res.status(503).json({ error: 'Client not ready' });
  const { chatId, mediaUrl, caption, mimetype } = req.body;
  if (!chatId || !mediaUrl) return res.status(400).json({ error: 'chatId and mediaUrl required' });

  try {
    const response = await fetch(mediaUrl);
    const buffer = Buffer.from(await response.arrayBuffer());
    const type = (mimetype || '').split('/')[0];

    let message;
    if (type === 'image') {
      message = { image: buffer, caption: caption || undefined, mimetype };
    } else if (type === 'video') {
      message = { video: buffer, caption: caption || undefined, mimetype };
    } else if (type === 'audio') {
      message = { audio: buffer, mimetype: mimetype || 'audio/mpeg', ptt: false };
    } else {
      const filename = mediaUrl.split('/').pop()?.split('?')[0] || 'file';
      message = { document: buffer, mimetype: mimetype || 'application/octet-stream', fileName: filename, caption: caption || undefined };
    }

    const sent = await sock.sendMessage(chatId, message);
    res.json({ success: true, id: sent?.key?.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/send-status', async (req, res) => {
  if (!sock) return res.status(503).json({ error: 'Client not ready' });
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  try {
    const sent = await sock.sendMessage('status@broadcast', { text: message });
    res.json({ success: true, id: sent?.key?.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/logout', async (req, res) => {
  try {
    if (sock) await sock.logout();
    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true });
    connectionStatus = 'disconnected';
    qrCode = null;
    res.json({ success: true });
    setTimeout(startConnection, 2000);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/reset', (req, res) => {
  if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true });
  connectionStatus = 'disconnected';
  qrCode = null;
  res.json({ success: true, message: 'Session cleared. Restarting...' });
  setTimeout(() => process.exit(0), 1000);
});

// Start
app.listen(PORT, () => {
  console.log(`WhatsApp server running on port ${PORT}`);
  console.log(`Session: ${SESSION_NAME}`);
  startConnection();
});
