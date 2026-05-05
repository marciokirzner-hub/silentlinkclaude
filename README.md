# SilentLink

A web-based silent party platform. DJs stream live audio from a browser; guests join via QR code and listen through their own headphones — no app required.

---

## Quick Start

```bash
npm install
npm run dev
# → http://localhost:3000
```

Open `/organizer` to create a session. Scan the QR code on your phone to listen.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  server.js  (Node.js — single process)                      │
│  ┌──────────────┐   ┌──────────────────────────────────┐   │
│  │  Next.js     │   │  WebSocket Signaling (/ws)        │   │
│  │  (pages/*)   │   │                                   │   │
│  │  Port 3000   │   │  rooms: Map<eventId, {            │   │
│  └──────────────┘   │    organizer: WebSocket,          │   │
│                     │    listeners: Map<id, WebSocket>  │   │
│                     │  }>                               │   │
│                     └──────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘

WebRTC flow (per listener):
  Organizer --[offer]--> Signaling --> Listener
  Listener  --[answer]-> Signaling --> Organizer
  Both      <---[ICE candidates]----> Signaling (relayed)
  Organizer ====[audio track, direct P2P]====> Listener
```

**Key design decisions:**

| Choice | Reason |
|---|---|
| One RTCPeerConnection per listener | Simplest for MVP; avoids SFU complexity |
| Custom Node server + `ws` | Next.js API routes don't support WebSocket upgrades |
| No DB / auth | MVP scope — event state lives in memory |
| `echoCancellation: false` | Prevents WebRTC from destroying music quality |
| ICE candidate buffering | Guards against race between offer arrival and answer |
| Lazy `listener-join` / re-join | Enables auto-reconnect without server state changes |

---

## Pages

| URL | Purpose |
|---|---|
| `/` | Landing page |
| `/organizer` | DJ dashboard — create event, select audio input, stream, show QR |
| `/listen/[eventId]` | Mobile listener page — join stream, volume control |

---

## Signaling Message Reference

### Client → Server

| `type` | Sender | Fields |
|---|---|---|
| `organizer-join` | Organizer | `eventId`, `eventName` |
| `listener-join` | Listener | `eventId` |
| `offer` | Organizer | `to` (listenerId), `sdp`, `eventId` |
| `answer` | Listener | `sdp`, `eventId` |
| `ice-candidate` | Both | `candidate`, `eventId`; organizer adds `to` |

### Server → Client

| `type` | Recipient | Fields |
|---|---|---|
| `organizer-joined` | Organizer | `listenerCount` |
| `listener-joined` | Listener | `listenerId`, `organizerActive`, `eventName` |
| `listener-connected` | Organizer | `listenerId`, `listenerCount` |
| `listener-disconnected` | Organizer | `listenerId`, `listenerCount` |
| `offer` | Listener | `sdp` |
| `answer` | Organizer | `sdp`, `from` (listenerId) |
| `ice-candidate` | Both | `candidate`; to organizer adds `from` |
| `organizer-disconnected` | Listener | _(none)_ |

---

## Mobile Testing (iPhone / Android)

### Same-network (simplest)
1. Find your laptop's local IP: `ipconfig getifaddr en0` (macOS)
2. Open `http://<your-ip>:3000/organizer` on your laptop
3. The QR code will encode the correct LAN URL
4. Phone must be on the same Wi-Fi network

> **Note:** Browsers block `getUserMedia` on non-`localhost` HTTP origins.  
> For real mobile testing you need HTTPS. Use a tunnel:

### Using ngrok (recommended for cross-network or HTTPS)
```bash
npm install -g ngrok
ngrok http 3000
# Gives you: https://xxxx.ngrok.io
```
Open the ngrok HTTPS URL in your browser for the organizer page — the QR code will encode the HTTPS listener URL automatically, which works on any phone.

---

## Manual Test Checklist

### Setup
- [ ] `npm run dev` starts without errors
- [ ] `/organizer` loads and shows a 6-char event ID
- [ ] Audio device dropdown lists your microphone/interface
- [ ] QR code appears and encodes the correct listener URL

### Organizer streaming
- [ ] Clicking **Start Streaming** requests microphone permission
- [ ] Audio level meter responds to sound input
- [ ] Meter turns red at high input levels
- [ ] **Stop Streaming** halts the stream and closes all peer connections

### Listener (same machine)
- [ ] Open `/listen/<eventId>` in a second tab
- [ ] **Join Stream** button triggers WebRTC negotiation
- [ ] Status transitions: connecting → negotiating → LIVE
- [ ] Audio from organizer is audible in listener tab
- [ ] Volume slider works
- [ ] **Leave** button disconnects cleanly

### Listener (iPhone)
- [ ] Scan QR code with Camera app
- [ ] Page loads correctly on mobile screen
- [ ] Tapping **Join Stream** (required user gesture for iOS audio)
- [ ] Audio plays through headphones
- [ ] Status shows LIVE with green pulse

### Listener (Android)
- [ ] Scan QR code
- [ ] Page loads, Join button visible
- [ ] Audio streams to headphones
- [ ] Status shows LIVE

### Reconnection
- [ ] Organizer stops streaming → listener shows "Waiting for DJ to start..."
- [ ] Organizer restarts streaming → listener reconnects automatically
- [ ] Kill and restart the server → organizer and listener both reconnect
- [ ] 5+ listeners connected simultaneously → all receive audio

### Scale / stress
- [ ] Open 10 listener tabs → organizer shows correct count
- [ ] Close listener tabs → count decrements correctly
- [ ] No audio glitches with 5 simultaneous listeners

---

## Known Limitations (MVP)

- **No TURN server** — connections may fail across NAT/firewalls (use ngrok as workaround)
- **~30–50 listeners** — organizer creates one RTCPeerConnection per listener; beyond ~50 the upload bandwidth (~64kbps × N) and CPU may become a bottleneck
- **In-memory state** — restarting the server clears all rooms
- **One event at a time per event ID** — no persistent storage
- **No HTTPS out of the box** — use ngrok or a reverse proxy for mobile testing
