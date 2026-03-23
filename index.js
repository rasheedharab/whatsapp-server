// Add this helper function near the top of index.js
async function sendWebhook(data) {
  if (!process.env.WEBHOOK_URL) return;
  try {
    await fetch(process.env.WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-secret': process.env.WEBHOOK_SECRET || ''
      },
      body: JSON.stringify(data)
    });
  } catch (e) {
    console.log('Webhook failed:', e.message);
  }
}

// Then in your client event handlers:

client.on('ready', async () => {
  const info = client.info;
  await sendWebhook({
    event: 'status_change',
    session: 'marhaba',  // match your session_name in the app
    status: 'connected',
    user: { phone: info?.wid?.user, name: info?.pushname }
  });
});

client.on('disconnected', async () => {
  await sendWebhook({
    event: 'status_change',
    session: 'marhaba',
    status: 'disconnected'
  });
});

client.on('qr', async () => {
  await sendWebhook({
    event: 'status_change',
    session: 'marhaba',
    status: 'linking'
  });
});

// end of this code

const express = require("express");
const cors = require("cors");
const { Client, LocalAuth } = require("whatsapp-web.js");
const QRCode = require("qrcode");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "";

// ─── Auth middleware ───
function auth(req, res, next) {
  if (!API_KEY) return next(); // no key = no auth (dev mode)
  const key =
    req.headers["x-api-key"] ||
    req.query.api_key;
  if (key !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}
app.use(auth);

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
});

client.on("ready", () => {
  qrData = null;
  clientReady = true;
  clientInfo = client.info;
  console.log("WhatsApp client is ready!", client.info.pushname);
});

client.on("disconnected", (reason) => {
  clientReady = false;
  clientInfo = null;
  console.log("Client disconnected:", reason);
  // Auto-reconnect
  setTimeout(() => client.initialize(), 5000);
});

client.on("auth_failure", (msg) => {
  console.error("Authentication failed:", msg);
  clientReady = false;
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
        profile_pic_url: null, // fetched separately if needed
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

// Get messages from a chat
app.get("/messages/:chatId", async (req, res) => {
  if (!clientReady) return res.status(503).json({ error: "Client not ready" });
  try {
    const limit = parseInt(req.query.limit) || 50;
    const chat = await client.getChatById(req.params.chatId);
    const messages = await chat.fetchMessages({ limit });
    const mapped = messages.map((m) => ({
      wa_message_id: m.id._serialized,
      from: m.from,
      to: m.to,
      body: m.body,
      timestamp: m.timestamp,
      is_from_me: m.fromMe,
      has_media: m.hasMedia,
      type: m.type,
    }));
    res.json(mapped);
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
            is_from_me: c.lastMessage.fromMe,
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
