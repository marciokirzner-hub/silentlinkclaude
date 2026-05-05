/**
 * Custom Next.js server with embedded WebSocket signaling.
 *
 * Message protocol:
 *  Organizer → Server: organizer-join, offer, ice-candidate
 *  Listener  → Server: listener-join, answer, ice-candidate
 *  Server → Organizer: organizer-joined, listener-connected, listener-disconnected, answer, ice-candidate
 *  Server → Listener:  listener-joined, offer, ice-candidate, organizer-disconnected
 */

const { createServer } = require("http");
const { parse } = require("url");
const next = require("next");
const { WebSocketServer } = require("ws");
const { randomUUID } = require("crypto");

const dev = process.env.NODE_ENV !== "production";
const port = parseInt(process.env.PORT || "3000", 10);
const app = next({ dev });
const handle = app.getRequestHandler();

// rooms: Map<eventId, { organizer: WS|null, eventName: string, listeners: Map<listenerId, WS> }>
const rooms = new Map();

function getOrCreateRoom(eventId, eventName = "Silent Party") {
  if (!rooms.has(eventId)) {
    rooms.set(eventId, { organizer: null, eventName, listeners: new Map() });
  }
  return rooms.get(eventId);
}

function safeSend(ws, data) {
  if (ws && ws.readyState === 1 /* OPEN */) {
    ws.send(JSON.stringify(data));
  }
}

app.prepare().then(() => {
  const server = createServer(async (req, res) => {
    const parsedUrl = parse(req.url, true);
    await handle(req, res, parsedUrl);
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const { pathname } = parse(request.url);
    if (pathname === "/ws") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on("connection", (ws) => {
    let role = null;      // 'organizer' | 'listener'
    let listenerId = null;
    let eventId = null;

    ws.on("message", async (rawData) => {
      let msg;
      try {
        msg = JSON.parse(rawData.toString());
      } catch {
        return;
      }

      switch (msg.type) {
        // ── Organizer registers ──────────────────────────────────────────
        case "organizer-join": {
          role = "organizer";
          eventId = msg.eventId;
          const room = getOrCreateRoom(eventId, msg.eventName || "Silent Party");
          room.organizer = ws;
          if (msg.eventName) room.eventName = msg.eventName;
          safeSend(ws, {
            type: "organizer-joined",
            listenerCount: room.listeners.size,
          });
          break;
        }

        // ── Listener registers ───────────────────────────────────────────
        case "listener-join": {
          role = "listener";
          eventId = msg.eventId;
          listenerId = randomUUID();
          const room = getOrCreateRoom(eventId);
          room.listeners.set(listenerId, ws);

          const organizerActive = !!(
            room.organizer && room.organizer.readyState === 1
          );

          safeSend(ws, {
            type: "listener-joined",
            listenerId,
            organizerActive,
            eventName: room.eventName,
          });

          // Tell organizer a new listener arrived
          safeSend(room.organizer, {
            type: "listener-connected",
            listenerId,
            listenerCount: room.listeners.size,
          });
          break;
        }

        // ── Organizer → Listener: WebRTC offer ───────────────────────────
        case "offer": {
          const room = rooms.get(eventId);
          if (!room) break;
          const lws = room.listeners.get(msg.to);
          safeSend(lws, { type: "offer", sdp: msg.sdp });
          break;
        }

        // ── Listener → Organizer: WebRTC answer ──────────────────────────
        case "answer": {
          const room = rooms.get(eventId);
          if (!room) break;
          safeSend(room.organizer, { type: "answer", sdp: msg.sdp, from: listenerId });
          break;
        }

        // ── ICE candidates (both directions) ─────────────────────────────
        case "ice-candidate": {
          const room = rooms.get(eventId);
          if (!room) break;
          if (role === "organizer") {
            const lws = room.listeners.get(msg.to);
            safeSend(lws, { type: "ice-candidate", candidate: msg.candidate });
          } else {
            safeSend(room.organizer, {
              type: "ice-candidate",
              candidate: msg.candidate,
              from: listenerId,
            });
          }
          break;
        }
      }
    });

    ws.on("close", () => {
      if (!eventId) return;
      const room = rooms.get(eventId);
      if (!room) return;

      if (role === "organizer") {
        room.organizer = null;
        room.listeners.forEach((lws) =>
          safeSend(lws, { type: "organizer-disconnected" })
        );
      } else if (role === "listener" && listenerId) {
        room.listeners.delete(listenerId);
        safeSend(room.organizer, {
          type: "listener-disconnected",
          listenerId,
          listenerCount: room.listeners.size,
        });
      }
    });

    ws.on("error", (err) => console.error("[ws] error:", err.message));
  });

  server.listen(port, () => {
    console.log(`\n  SilentLink ready → http://localhost:${port}\n`);
    console.log(`  Organizer:  http://localhost:${port}/organizer`);
    console.log(`  (QR code shown on organizer page)\n`);
  });
});
