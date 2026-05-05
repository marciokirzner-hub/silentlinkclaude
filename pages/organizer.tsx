import Head from "next/head";
import { QRCodeSVG } from "qrcode.react";
import {
  useState,
  useEffect,
  useRef,
  useCallback,
  CSSProperties,
} from "react";

function buildIceConfig(): RTCConfiguration {
  const servers: RTCIceServer[] = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ];
  // TURN server — set NEXT_PUBLIC_TURN_URL / _USERNAME / _CREDENTIAL in env
  if (process.env.NEXT_PUBLIC_TURN_URL) {
    servers.push({
      urls: process.env.NEXT_PUBLIC_TURN_URL,
      username: process.env.NEXT_PUBLIC_TURN_USERNAME,
      credential: process.env.NEXT_PUBLIC_TURN_CREDENTIAL,
    });
  }
  return { iceServers: servers };
}
const ICE = buildIceConfig();

function makeEventId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

type SignalStatus = "idle" | "connecting" | "connected" | "error";

export default function OrganizerPage() {
  const [eventId] = useState(makeEventId);
  const [eventName, setEventName] = useState("Silent Party");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [listenerCount, setListenerCount] = useState(0);
  const [audioLevel, setAudioLevel] = useState(0);
  const [listenerUrl, setListenerUrl] = useState("");
  const [wsStatus, setWsStatus] = useState<SignalStatus>("idle");
  const [copied, setCopied] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const pendingRef = useRef<string[]>([]); // listener IDs waiting for stream
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── listener URL ────────────────────────────────────────────────────────
  useEffect(() => {
    setListenerUrl(`${window.location.origin}/listen/${eventId}`);
  }, [eventId]);

  // ── enumerate audio devices ─────────────────────────────────────────────
  useEffect(() => {
    async function load() {
      try {
        // Trigger permission prompt so labels appear
        const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
        tmp.getTracks().forEach((t) => t.stop());
        const all = await navigator.mediaDevices.enumerateDevices();
        const inputs = all.filter((d) => d.kind === "audioinput");
        setDevices(inputs);
        if (inputs.length > 0) setDeviceId(inputs[0].deviceId);
      } catch (err) {
        console.warn("Cannot enumerate devices:", err);
      }
    }
    load();
  }, []);

  // ── create RTCPeerConnection for one listener ───────────────────────────
  const createPeer = useCallback(
    async (lid: string) => {
      if (!streamRef.current) return;
      if (peersRef.current.has(lid)) return; // already exists

      const pc = new RTCPeerConnection(ICE);
      peersRef.current.set(lid, pc);

      const senders: RTCRtpSender[] = [];
      streamRef.current.getAudioTracks().forEach((track) => {
        senders.push(pc.addTrack(track, streamRef.current!));
      });

      // Bump Opus to 128 kbps stereo, disable DTX (which degrades music during quiet passages)
      pc.onnegotiationneeded = async () => {
        for (const sender of senders) {
          const params = sender.getParameters();
          if (!params.encodings?.length) params.encodings = [{}];
          params.encodings[0].maxBitrate = 128_000;
          // @ts-expect-error — non-standard but supported in Chrome/Firefox/Safari
          params.encodings[0].dtx = false;
          await sender.setParameters(params).catch(() => {});
        }
      };

      pc.onicecandidate = ({ candidate }) => {
        if (!candidate) return;
        wsRef.current?.readyState === WebSocket.OPEN &&
          wsRef.current.send(
            JSON.stringify({
              type: "ice-candidate",
              to: lid,
              candidate,
              eventId,
            })
          );
      };

      pc.onconnectionstatechange = () => {
        if (
          pc.connectionState === "failed" ||
          pc.connectionState === "closed"
        ) {
          pc.close();
          peersRef.current.delete(lid);
        }
      };

      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        wsRef.current?.send(
          JSON.stringify({ type: "offer", to: lid, sdp: offer, eventId })
        );
      } catch (err) {
        console.error("Offer failed:", err);
        peersRef.current.delete(lid);
      }
    },
    [eventId]
  );

  // ── WebSocket connect / reconnect ───────────────────────────────────────
  const connectWs = useCallback(() => {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);

    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${window.location.host}/ws`);
    wsRef.current = ws;
    setWsStatus("connecting");

    ws.onopen = () => {
      setWsStatus("connected");
      ws.send(JSON.stringify({ type: "organizer-join", eventId, eventName }));
    };

    ws.onmessage = async ({ data }) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }

      switch (msg.type) {
        case "organizer-joined": {
          setListenerCount((msg.listenerCount as number) || 0);
          // Re-offer to any listeners already waiting (e.g. after organizer WS reconnect)
          const existingIds = (msg.listenerIds as string[]) || [];
          if (streamRef.current) {
            for (const lid of existingIds) await createPeer(lid);
          } else {
            for (const lid of existingIds) {
              if (!pendingRef.current.includes(lid)) pendingRef.current.push(lid);
            }
          }
          break;
        }

        case "listener-connected": {
          const lid = msg.listenerId as string;
          setListenerCount(msg.listenerCount as number);
          if (streamRef.current) {
            await createPeer(lid);
          } else {
            if (!pendingRef.current.includes(lid)) {
              pendingRef.current.push(lid);
            }
          }
          break;
        }

        case "listener-disconnected": {
          const lid = msg.listenerId as string;
          setListenerCount(msg.listenerCount as number);
          const pc = peersRef.current.get(lid);
          if (pc) {
            pc.close();
            peersRef.current.delete(lid);
          }
          pendingRef.current = pendingRef.current.filter((id) => id !== lid);
          break;
        }

        case "answer": {
          const pc = peersRef.current.get(msg.from as string);
          if (pc) {
            try {
              await pc.setRemoteDescription(
                new RTCSessionDescription(msg.sdp as RTCSessionDescriptionInit)
              );
            } catch (err) {
              console.error("setRemoteDescription failed:", err);
            }
          }
          break;
        }

        case "ice-candidate": {
          const pc = peersRef.current.get(msg.from as string);
          if (pc) {
            try {
              await pc.addIceCandidate(
                new RTCIceCandidate(
                  msg.candidate as RTCIceCandidateInit
                )
              );
            } catch {
              // Non-fatal; trickle ICE sometimes races
            }
          }
          break;
        }
      }
    };

    ws.onclose = () => {
      setWsStatus("idle");
      reconnectTimerRef.current = setTimeout(connectWs, 3000);
    };

    ws.onerror = () => setWsStatus("error");
  }, [eventId, eventName, createPeer]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    connectWs();
    return () => {
      wsRef.current?.close();
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── audio level metering ────────────────────────────────────────────────
  const startMeter = useCallback((stream: MediaStream) => {
    const ctx = new AudioContext();
    audioCtxRef.current = ctx;
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyserRef.current = analyser;
    src.connect(analyser);

    const buf = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteFrequencyData(buf);
      const avg = buf.reduce((a, b) => a + b, 0) / buf.length;
      setAudioLevel(avg / 255);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const stopMeter = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    audioCtxRef.current?.close();
    audioCtxRef.current = null;
    analyserRef.current = null;
    setAudioLevel(0);
  }, []);

  // ── start / stop streaming ──────────────────────────────────────────────
  const startStreaming = useCallback(async () => {
    try {
      const constraints: MediaStreamConstraints = {
        audio: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          sampleRate: 48000,
          channelCount: 2,
        },
        video: false,
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;
      setIsStreaming(true);
      startMeter(stream);

      for (const lid of pendingRef.current) {
        await createPeer(lid);
      }
      pendingRef.current = [];
    } catch (err) {
      console.error("getUserMedia failed:", err);
      alert(
        "Could not access audio input. Check permissions and device selection."
      );
    }
  }, [deviceId, startMeter, createPeer]);

  const stopStreaming = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    peersRef.current.forEach((pc) => pc.close());
    peersRef.current.clear();
    stopMeter();
    setIsStreaming(false);
  }, [stopMeter]);

  const copyLink = useCallback(() => {
    navigator.clipboard.writeText(listenerUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [listenerUrl]);

  // ── bar color based on level ────────────────────────────────────────────
  const meterColor =
    audioLevel > 0.8 ? "#ef4444" : audioLevel > 0.5 ? "#eab308" : "#22c55e";

  return (
    <>
      <Head>
        <title>SilentLink — Organizer</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>
      <div style={s.page}>
        <div style={s.header}>
          <span style={s.headerLogo}>🎧 SilentLink</span>
          <span style={{ ...s.dot, background: WS_DOT[wsStatus] }} />
          <span style={s.wsLabel}>{wsStatus}</span>
        </div>

        <div style={s.grid}>
          {/* Left column: controls */}
          <div style={s.col}>
            <section style={s.card}>
              <h2 style={s.sectionTitle}>Event</h2>
              <label style={s.label}>Event Name</label>
              <input
                value={eventName}
                onChange={(e) => setEventName(e.target.value)}
                placeholder="Silent Party"
                disabled={isStreaming}
              />
              <div style={s.eventIdRow}>
                <span style={s.label}>Event ID</span>
                <span style={s.eventId}>{eventId}</span>
              </div>
            </section>

            <section style={s.card}>
              <h2 style={s.sectionTitle}>Audio Input</h2>
              <label style={s.label}>Device</label>
              <select
                value={deviceId}
                onChange={(e) => setDeviceId(e.target.value)}
                disabled={isStreaming}
              >
                {devices.length === 0 && (
                  <option value="">Default (no permissions yet)</option>
                )}
                {devices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `Audio Input ${d.deviceId.slice(0, 6)}`}
                  </option>
                ))}
              </select>

              <div style={s.meterWrap}>
                <div style={s.meterBg}>
                  <div
                    style={{
                      ...s.meterFill,
                      width: `${audioLevel * 100}%`,
                      background: meterColor,
                    }}
                  />
                </div>
                <span style={s.meterLabel}>
                  {isStreaming
                    ? audioLevel < 0.01
                      ? "No signal"
                      : "Signal OK"
                    : "Idle"}
                </span>
              </div>

              <button
                style={{
                  ...s.btn,
                  background: isStreaming ? "var(--red)" : "var(--green)",
                }}
                onClick={isStreaming ? stopStreaming : startStreaming}
              >
                {isStreaming ? "⏹ Stop Streaming" : "▶ Start Streaming"}
              </button>
            </section>

            <section style={s.card}>
              <h2 style={s.sectionTitle}>Listeners</h2>
              <div style={s.listenerCount}>
                <span style={s.countNum}>{listenerCount}</span>
                <span style={s.countLabel}>
                  {listenerCount === 1 ? "listener" : "listeners"} connected
                </span>
              </div>
              {!isStreaming && listenerCount > 0 && (
                <p style={s.hint}>
                  {listenerCount} listener(s) waiting — press Start to begin
                  streaming.
                </p>
              )}
            </section>
          </div>

          {/* Right column: QR code */}
          <div style={s.col}>
            <section style={{ ...s.card, alignItems: "center" }}>
              <h2 style={s.sectionTitle}>Share with Guests</h2>
              <p style={s.label}>Scan to listen on phone</p>
              {listenerUrl && (
                <div style={s.qrWrap}>
                  <QRCodeSVG
                    value={listenerUrl}
                    size={220}
                    bgColor="#ffffff"
                    fgColor="#0a0a0f"
                    level="M"
                  />
                </div>
              )}
              <div style={s.urlRow}>
                <span style={s.urlText}>{listenerUrl}</span>
              </div>
              <button style={s.copyBtn} onClick={copyLink}>
                {copied ? "✓ Copied!" : "Copy Link"}
              </button>
              <p style={s.httpsNote}>
                For mobile access share the link above or use a tunnel (e.g.
                ngrok) — HTTPS required on real devices.
              </p>
            </section>
          </div>
        </div>
      </div>
    </>
  );
}

const WS_DOT: Record<SignalStatus, string> = {
  idle: "#555",
  connecting: "#eab308",
  connected: "#22c55e",
  error: "#ef4444",
};

const s: Record<string, CSSProperties> = {
  page: {
    minHeight: "100%",
    padding: "0 0 40px",
    maxWidth: 900,
    margin: "0 auto",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "20px 24px",
    borderBottom: "1px solid var(--border)",
    marginBottom: 28,
  },
  headerLogo: { fontSize: 18, fontWeight: 700, flex: 1 },
  dot: {
    width: 10,
    height: 10,
    borderRadius: "50%",
    display: "inline-block",
  },
  wsLabel: { fontSize: 13, color: "var(--text2)" },
  grid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 20,
    padding: "0 24px",
  },
  col: { display: "flex", flexDirection: "column", gap: 20 },
  card: {
    background: "var(--bg2)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    padding: "20px 24px",
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  sectionTitle: { fontSize: 14, fontWeight: 600, color: "var(--text2)", textTransform: "uppercase", letterSpacing: "0.05em" },
  label: { fontSize: 13, color: "var(--text2)" },
  eventIdRow: { display: "flex", alignItems: "center", gap: 10 },
  eventId: {
    fontFamily: "monospace",
    fontSize: 22,
    fontWeight: 700,
    letterSpacing: 4,
    color: "var(--purple)",
  },
  meterWrap: { display: "flex", flexDirection: "column", gap: 6 },
  meterBg: {
    height: 12,
    background: "var(--bg3)",
    borderRadius: 6,
    overflow: "hidden",
  },
  meterFill: {
    height: "100%",
    borderRadius: 6,
    transition: "width 0.05s linear, background 0.1s",
  },
  meterLabel: { fontSize: 12, color: "var(--text2)" },
  btn: {
    padding: "12px 20px",
    borderRadius: "var(--radius-sm)",
    fontSize: 15,
    fontWeight: 600,
    color: "#fff",
    border: "none",
    cursor: "pointer",
    transition: "opacity 0.15s",
  },
  listenerCount: { display: "flex", alignItems: "baseline", gap: 10 },
  countNum: { fontSize: 48, fontWeight: 700, lineHeight: 1, color: "var(--green)" },
  countLabel: { fontSize: 16, color: "var(--text2)" },
  hint: { fontSize: 13, color: "var(--yellow)" },
  qrWrap: {
    background: "#fff",
    padding: 16,
    borderRadius: 12,
    display: "inline-block",
  },
  urlRow: {
    background: "var(--bg3)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-sm)",
    padding: "8px 12px",
    width: "100%",
    overflowX: "auto",
  },
  urlText: { fontFamily: "monospace", fontSize: 12, color: "var(--text2)", wordBreak: "break-all" },
  copyBtn: {
    background: "var(--blue)",
    color: "#fff",
    padding: "10px 20px",
    borderRadius: "var(--radius-sm)",
    fontSize: 14,
    fontWeight: 600,
    width: "100%",
    cursor: "pointer",
    border: "none",
  },
  httpsNote: {
    fontSize: 11,
    color: "var(--text2)",
    textAlign: "center",
    lineHeight: 1.6,
  },
};
