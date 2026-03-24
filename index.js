const express = require("express");
const cors = require("cors");
const { Client, LocalAuth } = require("whatsapp-web.js");
const QRCode = require("qrcode");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "";
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";

// ─── Auth middleware ───
function auth(req, res, next) {
  if (!API_KEY) return next();
  const key = req.headers["x-api-key"] || req.query.api_key;
  if (key !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}
app.use(auth);

// ─── Webhook helper ───
async function sendWebhook(payload) {
  if (!WEBHOOK_URL) return;
  try {
    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(API_KEY ? { "x-webhook-secret": API_KEY } : {}),
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error("Webhook delivery failed:", err.message);
  }
}

// ─── WhatsApp client ───
let qrData = null;
let clientReady = false;
let clientInfo = null;

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  },
});

client.on("qr", (qr) => {
  qrData = qr;
  clientReady = false;
  console.log("QR code received. Scan it from the /qr endpoint.");
  sendWebhook({ event: "qr", session: process.env.SESSION_NAME || "default" });
});

client.on("ready", () => {
  qrData = null;
  clientReady = true;
  clientInfo = client.info;
  console.log("WhatsApp client is ready!", client.info.pushname);
  sendWebhook({
    event: "ready",
    session: process.env.SESSION_NAME || "default",
    user: { name: clientInfo.pushname, phone: clientInfo.wid.user },
  });
});

client.on("disconnected", (reason) => {
  clientReady = false;
  clientInfo = null;
  console.log("Client disconnected:", reason);
  sendWebhook({ event: "disconnected", session: process.env.SESSION_NAME || "default" });
  setTimeout(() => client.initialize(), 5000);
});

client.on("auth_failure", (msg) => {
  console.error("Authentication failed:", msg);
  clientReady = false;
  sendWebhook({ event: "auth_failure", session: process.env.SESSION_NAME || "default" });
});

// ─── Forward incoming messages via webhook ───
client.on("message", async (msg) => {
  sendWebhook({
    event: "message_received",
    session: process.env.SESSION_NAME || "default",
    message: {
      wa_message_id: msg.id._serialized,
      chat_id: msg.from,
      body: msg.body,
      sender: msg._data?.notifyName || "",
      sender_jid: msg.author || msg.from,
      timestamp: msg.timestamp,
      fromMe: msg.fromMe,
      hasMedia: msg.hasMedia,
      type: msg.type,
    },
  });
});

client.initialize();

// ─── Routes ───

// Health / status check
app.get("/status", (req, res) => {
  res.json({
    connected: clientReady,
    user: clientInfo
      ? { name: clientInfo.pushname, phone: clientInfo.wid.user }
      : null,
    qrPending: !!qrData,
  });
});

// QR code as base64 image
app.get("/qr", async (req, res) => {
  if (clientReady) return res.json({ status: "already_connected" });
  if (!qrData) return res.json({ status: "waiting_for_qr", qr: null });
  try {
    const qrImage = await QRCode.toDataURL(qrData);
    res.json({ status: "scan_required", qr: qrImage });
  } catch (err) {
    res.status(500).json({ error: "Failed to generate QR" });
  }
});

// Get all contacts
app.get("/contacts", async (req, res) => {
  if (!clientReady) return res.status(503).json({ error: "Client not ready" });
  try {
    const contacts = await client.getContacts();
    const mapped = contacts
      .filter((c) => c.id.server === "c.us" && c.isMyContact)
      .map((c) => ({
        wa_id: c.id._serialized,
        name: c.name || c.pushname || c.number,
        phone: c.number,
        is_business: c.isBusiness,
        profile_pic_url: null,
      }));
    res.json(mapped);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all groups
app.get("/groups", async (req, res) => {
  if (!clientReady) return res.status(503).json({ error: "Client not ready" });
  try {
    const chats = await client.getChats();
    const groups = chats.filter((c) => c.isGroup);
    const mapped = await Promise.all(
      groups.map(async (g) => {
        const metadata = await g.groupMetadata?.() || {};
        return {
          wa_id: g.id._serialized,
          name: g.name,
          description: metadata.desc || "",
          member_count: metadata.participants?.length || 0,
          members: (metadata.participants || []).map((p) => ({
            id: p.id._serialized,
            isAdmin: p.isAdmin || p.isSuperAdmin,
          })),
          admins: (metadata.participants || [])
            .filter((p) => p.isAdmin || p.isSuperAdmin)
            .map((p) => p.id._serialized),
        };
      })
    );
    res.json(mapped);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get group participants
app.get("/groups/:groupId/participants", async (req, res) => {
  if (!clientReady) return res.status(503).json({ error: "Client not ready" });
  try {
    const groupId = decodeURIComponent(req.params.groupId);
    const chat = await client.getChatById(groupId);
    if (!chat.isGroup) return res.status(400).json({ error: "Not a group chat" });
    const metadata = await chat.groupMetadata?.() || {};
    const participants = (metadata.participants || []).map((p) => ({
      id: p.id._serialized,
      name: p.pushname || p.name || null,
      isAdmin: p.isAdmin || p.isSuperAdmin || false,
    }));
    res.json({ participants });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PAGINATED message history ───
// GET /messages/:chatId?limit=50&before=<timestamp>
// - limit: number of messages to fetch (default 50, max 500)
// - before: unix timestamp — only return messages older than this (for pagination)
app.get("/messages/:chatId", async (req, res) => {
  if (!clientReady) return res.status(503).json({ error: "Client not ready" });
  try {
    const chatId = decodeURIComponent(req.params.chatId);
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const beforeTs = req.query.before ? parseInt(req.query.before) : null;

    const chat = await client.getChatById(chatId);

    // Fetch more than needed so we can filter by timestamp
    const fetchCount = beforeTs ? limit + 100 : limit;
    const messages = await chat.fetchMessages({ limit: fetchCount });

    let filtered = messages;
    if (beforeTs) {
      filtered = messages.filter((m) => m.timestamp < beforeTs);
    }

    // Take only the requested limit (last N messages)
    const sliced = filtered.slice(-limit);

    const mapped = sliced.map((m) => ({
      wa_message_id: m.id._serialized,
      id: m.id._serialized,
      from: m.from,
      to: m.to,
      body: m.body,
      timestamp: m.timestamp,
      fromMe: m.fromMe,
      is_from_me: m.fromMe,
      sender: m._data?.notifyName || "",
      hasMedia: m.hasMedia,
      type: m.type,
    }));

    res.json({
      messages: mapped,
      has_more: filtered.length > sliced.length,
      oldest_timestamp: mapped.length > 0 ? mapped[0].timestamp : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send a message
app.post("/send", async (req, res) => {
  if (!clientReady) return res.status(503).json({ error: "Client not ready" });
  try {
    const { chatId, message } = req.body;
    if (!chatId || !message) {
      return res.status(400).json({ error: "chatId and message are required" });
    }
    const result = await client.sendMessage(chatId, message);
    res.json({
      success: true,
      wa_message_id: result.id._serialized,
      timestamp: result.timestamp,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send WhatsApp status (text)
app.post("/send-status", async (req, res) => {
  if (!clientReady) return res.status(503).json({ error: "Client not ready" });
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: "message is required" });
    const result = await client.sendMessage("status@broadcast", message);
    res.json({
      success: true,
      wa_message_id: result.id._serialized,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all chats (for conversations page)
app.get("/chats", async (req, res) => {
  if (!clientReady) return res.status(503).json({ error: "Client not ready" });
  try {
    const chats = await client.getChats();
    const mapped = chats.slice(0, 100).map((c) => ({
      wa_id: c.id._serialized,
      name: c.name,
      is_group: c.isGroup,
      unread_count: c.unreadCount,
      last_message: c.lastMessage
        ? {
            body: c.lastMessage.body,
            timestamp: c.lastMessage.timestamp,
            fromMe: c.lastMessage.fromMe,
            is_from_me: c.lastMessage.fromMe,
            sender: c.lastMessage._data?.notifyName || "",
          }
        : null,
      timestamp: c.timestamp,
    }));
    res.json(mapped);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Logout (disconnect WhatsApp)
app.post("/logout", async (req, res) => {
  if (!clientReady) return res.status(503).json({ error: "Client not ready" });
  try {
    await client.logout();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`WhatsApp server running on port ${PORT}`);
});
