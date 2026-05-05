import Head from "next/head";
import { useRouter } from "next/router";
import {
  useState,
  useEffect,
  useRef,
  useCallback,
  CSSProperties,
} from "react";

const ICE = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

type Status =
  | "idle"
  | "connecting"
  | "waiting_organizer"
  | "negotiating"
  | "live"
  | "reconnecting"
  | "error";

const STATUS_LABEL: Record<Status, string> = {
  idle: "Ready to join",
  connecting: "Connecting...",
  waiting_organizer: "Waiting for DJ to start...",
  negotiating: "Connecting audio...",
  live: "LIVE",
  reconnecting: "Reconnecting...",
  error: "Connection error",
};

const STATUS_COLOR: Record<Status, string> = {
  idle: "#8888aa",
  connecting: "#eab308",
  waiting_organizer: "#eab308",
  negotiating: "#3b82f6",
  live: "#22c55e",
  reconnecting: "#eab308",
  error: "#ef4444",
};

export default function ListenPage() {
  const router = useRouter();
  const { eventId } = router.query as { eventId: string };

  const [status, setStatus] = useState<Status>("idle");
  const [eventName, setEventName] = useState("Silent Party");
  const [hasJoined, setHasJoined] = useState(false);
  const [volume, setVolume] = useState(1);

  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const listenerIdRef = useRef<string | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const iceBufRef = useRef<RTCIceCandidateInit[]>([]); // buffer before remote desc
  const eventIdRef = useRef<string>("");

  // Keep eventIdRef in sync
  useEffect(() => {
    if (eventId) eventIdRef.current = eventId;
  }, [eventId]);

  // Create audio element once
  useEffect(() => {
    const el = document.createElement("audio");
    el.autoplay = true;
    el.setAttribute("playsinline", "true");
    el.volume = volume;
    audioRef.current = el;
    return () => {
      el.srcObject = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync volume changes
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  // ── cleanup helpers ─────────────────────────────────────────────────────
  const closePc = useCallback(() => {
    pcRef.current?.close();
    pcRef.current = null;
    iceBufRef.current = [];
  }, []);

  const closeWs = useCallback(() => {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    const ws = wsRef.current;
    if (ws) {
      ws.onclose = null; // prevent recursive reconnect
      ws.close();
      wsRef.current = null;
    }
  }, []);

  // ── main connect flow ───────────────────────────────────────────────────
  const connect = useCallback(() => {
    const eid = eventIdRef.current;
    if (!eid) return;

    closeWs();
    closePc();

    setStatus("connecting");

    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${window.location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "listener-join", eventId: eid }));
    };

    ws.onmessage = async ({ data }) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }

      switch (msg.type) {
        // ── assigned our ID ────────────────────────────────────────────
        case "listener-joined": {
          listenerIdRef.current = msg.listenerId as string;
          if (msg.eventName) setEventName(msg.eventName as string);
          if (msg.organizerActive) {
            setStatus("negotiating");
          } else {
            setStatus("waiting_organizer");
          }
          break;
        }

        // ── organizer disconnected ─────────────────────────────────────
        case "organizer-disconnected": {
          closePc();
          if (audioRef.current) audioRef.current.srcObject = null;
          setStatus("waiting_organizer");
          break;
        }

        // ── received WebRTC offer ──────────────────────────────────────
        case "offer": {
          setStatus("negotiating");
          const eid2 = eventIdRef.current;

          closePc();
          const pc = new RTCPeerConnection(ICE);
          pcRef.current = pc;
          iceBufRef.current = [];

          pc.ontrack = ({ streams }) => {
            if (streams[0] && audioRef.current) {
              audioRef.current.srcObject = streams[0];
              audioRef.current.play().catch(() => {
                // Autoplay blocked — user interaction needed (handled by join btn)
              });
              setStatus("live");
            }
          };

          pc.onicecandidate = ({ candidate }) => {
            if (!candidate) return;
            ws.readyState === WebSocket.OPEN &&
              ws.send(
                JSON.stringify({
                  type: "ice-candidate",
                  candidate,
                  eventId: eid2,
                })
              );
          };

          pc.onconnectionstatechange = () => {
            if (pc.connectionState === "failed") {
              setStatus("reconnecting");
              if (audioRef.current) audioRef.current.srcObject = null;
              closePc();
              reconnectTimerRef.current = setTimeout(() => connect(), 3000);
            }
            if (pc.connectionState === "disconnected") {
              setStatus("reconnecting");
            }
            if (pc.connectionState === "connected") {
              setStatus("live");
            }
          };

          try {
            await pc.setRemoteDescription(
              new RTCSessionDescription(msg.sdp as RTCSessionDescriptionInit)
            );

            // Flush buffered ICE candidates
            for (const c of iceBufRef.current) {
              await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
            }
            iceBufRef.current = [];

            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            ws.send(
              JSON.stringify({ type: "answer", sdp: answer, eventId: eid2 })
            );
          } catch (err) {
            console.error("Offer handling failed:", err);
            setStatus("error");
          }
          break;
        }

        // ── ICE candidate from organizer ───────────────────────────────
        case "ice-candidate": {
          const candidate = msg.candidate as RTCIceCandidateInit;
          const pc = pcRef.current;
          if (pc && pc.remoteDescription) {
            pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
          } else {
            iceBufRef.current.push(candidate);
          }
          break;
        }
      }
    };

    ws.onclose = () => {
      if (status !== "idle") {
        setStatus("reconnecting");
        reconnectTimerRef.current = setTimeout(() => connect(), 3000);
      }
    };

    ws.onerror = () => setStatus("error");
  }, [closeWs, closePc]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── join button handler ─────────────────────────────────────────────────
  const handleJoin = useCallback(() => {
    setHasJoined(true);
    connect();
  }, [connect]);

  const handleDisconnect = useCallback(() => {
    closeWs();
    closePc();
    if (audioRef.current) audioRef.current.srcObject = null;
    setHasJoined(false);
    setStatus("idle");
  }, [closeWs, closePc]);

  // ── cleanup on unmount ──────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      closeWs();
      closePc();
    };
  }, [closeWs, closePc]);

  const isLive = status === "live";
  const showReconnect =
    status === "error" ||
    (status === "reconnecting" && !reconnectTimerRef.current);

  return (
    <>
      <Head>
        <title>{eventName} — SilentLink</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#0a0a0f" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
      </Head>
      <div style={s.page}>
        <div style={s.inner}>
          {/* Logo */}
          <div style={s.logo}>
            <span style={s.logoIcon}>🎧</span>
            <span style={s.logoText}>SilentLink</span>
          </div>

          {/* Event info */}
          <h1 style={s.eventName}>{eventName}</h1>
          <p style={s.eventId}>Room: {eventId}</p>

          {/* Status badge */}
          <div style={{ ...s.badge, background: `${STATUS_COLOR[status]}22`, borderColor: STATUS_COLOR[status] }}>
            {isLive && <span style={{ ...s.pulseDot, background: STATUS_COLOR[status] }} />}
            <span style={{ color: STATUS_COLOR[status], fontWeight: 600 }}>
              {STATUS_LABEL[status]}
            </span>
          </div>

          {/* Big join button */}
          {!hasJoined ? (
            <button style={s.joinBtn} onClick={handleJoin}>
              <span style={s.joinIcon}>▶</span>
              Join Stream
            </button>
          ) : (
            <>
              {/* Animated audio indicator */}
              <div style={s.waveWrap}>
                {[0.4, 0.7, 1, 0.7, 0.4].map((h, i) => (
                  <div
                    key={i}
                    style={{
                      ...s.waveBar,
                      height: isLive ? `${h * 48}px` : "8px",
                      background: isLive ? "#22c55e" : "#333",
                      animationDelay: `${i * 0.1}s`,
                      animation: isLive ? "wave 0.8s ease-in-out infinite alternate" : "none",
                    }}
                  />
                ))}
              </div>

              {/* Volume control */}
              <div style={s.volumeWrap}>
                <span style={s.volIcon}>🔈</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={volume}
                  onChange={(e) => setVolume(parseFloat(e.target.value))}
                  style={s.slider}
                />
                <span style={s.volIcon}>🔊</span>
              </div>

              {showReconnect ? (
                <button style={s.reconnectBtn} onClick={() => connect()}>
                  Reconnect
                </button>
              ) : (
                <button style={s.leaveBtn} onClick={handleDisconnect}>
                  Leave
                </button>
              )}
            </>
          )}

          <p style={s.footer}>
            Put on your headphones and enjoy the party.
          </p>
        </div>
      </div>

      <style>{`
        @keyframes wave {
          0%   { transform: scaleY(0.4); }
          100% { transform: scaleY(1); }
        }
      `}</style>
    </>
  );
}

const s: Record<string, CSSProperties> = {
  page: {
    minHeight: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "32px 24px",
  },
  inner: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 24,
    maxWidth: 360,
    width: "100%",
    textAlign: "center",
  },
  logo: { display: "flex", alignItems: "center", gap: 8 },
  logoIcon: { fontSize: 28 },
  logoText: { fontSize: 20, fontWeight: 700, color: "var(--text2)" },
  eventName: { fontSize: 28, fontWeight: 700, letterSpacing: "-0.5px" },
  eventId: { fontSize: 13, color: "var(--text2)" },
  badge: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 16px",
    borderRadius: 100,
    border: "1px solid",
    fontSize: 14,
  },
  pulseDot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    animation: "pulse 1.5s ease-in-out infinite",
  },
  joinBtn: {
    background: "var(--green)",
    color: "#fff",
    border: "none",
    borderRadius: 100,
    padding: "20px 48px",
    fontSize: 22,
    fontWeight: 700,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    gap: 12,
    boxShadow: "0 0 40px #22c55e44",
  },
  joinIcon: { fontSize: 24 },
  waveWrap: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    height: 56,
    padding: "4px 0",
  },
  waveBar: {
    width: 6,
    borderRadius: 3,
    transition: "height 0.3s, background 0.3s",
    transformOrigin: "center",
  },
  volumeWrap: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    width: "100%",
    maxWidth: 280,
  },
  volIcon: { fontSize: 18 },
  slider: {
    flex: 1,
    accentColor: "var(--green)",
    cursor: "pointer",
    height: 4,
  },
  leaveBtn: {
    background: "transparent",
    border: "1px solid var(--border)",
    color: "var(--text2)",
    padding: "10px 28px",
    borderRadius: 100,
    fontSize: 14,
    cursor: "pointer",
  },
  reconnectBtn: {
    background: "var(--yellow)",
    color: "#000",
    border: "none",
    padding: "12px 28px",
    borderRadius: 100,
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
  },
  footer: {
    fontSize: 12,
    color: "var(--text2)",
    marginTop: 8,
  },
};
