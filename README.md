# WhatsApp Server (Baileys)

Lightweight WhatsApp REST API server using [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys). No Chromium needed!

## Advantages over whatsapp-web.js
- **No browser required** — direct WebSocket connection
- **~50MB RAM** vs ~500MB with Puppeteer/Chromium
- **Faster boot** — connects in seconds, not minutes
- **Simpler Docker** — just Node.js, no Chromium dependencies
- **Session persistence** — file-based auth survives restarts

## Deploy to Railway

1. Replace the contents of your `whatsapp-server` repo with these files
2. Push to GitHub — Railway will auto-deploy
3. Set environment variables in Railway:
   - `PORT` = `8080`
   - `API_KEY` = your secret key (same as before)

## API Endpoints (same as before)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/status` | Connection status |
| GET | `/qr` | QR code for linking |
| GET | `/contacts` | All contacts |
| GET | `/groups` | All groups with members |
| GET | `/chats` | All chats |
| GET | `/messages/:chatId` | Messages from a chat |
| POST | `/send` | Send message `{chatId, message}` |
| POST | `/send-status` | Post status `{message}` |
| POST | `/logout` | Disconnect WhatsApp |
| POST | `/reset` | Reset session & get new QR |

## Session Persistence on Railway

Add a Railway volume mounted at `/app/auth_state` to persist sessions across restarts:
1. Railway dashboard → your service → **Volumes**
2. Click **Add Volume**
3. Mount path: `/app/auth_state`
4. Size: 1 GB is plenty
