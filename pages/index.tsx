import Head from "next/head";
import Link from "next/link";

export default function Home() {
  return (
    <>
      <Head>
        <title>SilentLink</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>
      <div style={styles.page}>
        <div style={styles.card}>
          <div style={styles.logo}>
            <span style={styles.logoIcon}>🎧</span>
            <h1 style={styles.title}>SilentLink</h1>
          </div>
          <p style={styles.tagline}>
            Stream live audio to any headphones in the room.
            <br />
            No app. No cables. Just a QR code.
          </p>
          <Link href="/organizer" style={styles.btn}>
            Start as DJ / Organizer
          </Link>
        </div>
      </div>
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    height: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  card: {
    background: "var(--bg2)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    padding: "48px 40px",
    maxWidth: 440,
    width: "100%",
    textAlign: "center",
  },
  logo: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    marginBottom: 16,
  },
  logoIcon: { fontSize: 40 },
  title: { fontSize: 32, fontWeight: 700, letterSpacing: "-0.5px" },
  tagline: {
    color: "var(--text2)",
    fontSize: 16,
    lineHeight: 1.7,
    marginBottom: 32,
  },
  btn: {
    display: "inline-block",
    background: "var(--purple)",
    color: "#fff",
    padding: "14px 28px",
    borderRadius: "var(--radius-sm)",
    fontSize: 16,
    fontWeight: 600,
    textDecoration: "none",
    transition: "opacity 0.15s",
  },
};
