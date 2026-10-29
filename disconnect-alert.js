// disconnect-alert.js — peringatan kalau banyak pemain disconnect serempak.
//
// Pasang di index.js (satu baris, setelah `const client = new Client(...)`):
//   require('./disconnect-alert')(client);
//
// Cara kerja: bot memantau channel yang kamu isi di variabel DISCONNECT_WATCH_CHANNEL_ID. Tiap ada embed
// webhook berjudul "Player Left Server" (dari Server Monitor), bot mencatat username-nya. Kalau dalam
// jendela waktu pendek ada LEBIH DARI 15 pemain berbeda yang keluar, bot mention admin dengan pesan peringatan.
//
// ENV:
//   DISCONNECT_WATCH_CHANNEL_ID   (WAJIB) ID channel embed "Player Left Server", boleh banyak, pisah koma
//   DISCONNECT_ALERT_USER_ID      ID user yang di-mention (default 870201488218157107)
//   DISCONNECT_THRESHOLD          alert kalau jumlah pemain keluar LEBIH DARI angka ini (default 15)
//   DISCONNECT_WINDOW_SECONDS     jendela waktu "serempak" dalam detik (default 30)
//   DISCONNECT_COOLDOWN_MINUTES   jeda minimal antar alert supaya gak spam (default 5)
//   DISCONNECT_ALERT_CHANNEL_ID   channel tempat alert dikirim (default: channel yang dipantau)
//   DISCONNECT_ALERT_MESSAGE      ganti kalimat peringatan (mention tetap ditaruh di depan)

const csv = (v) => (v || '').split(',').map((x) => x.trim()).filter(Boolean);
const int = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};

const WATCH = new Set(csv(process.env.DISCONNECT_WATCH_CHANNEL_ID));
const ALERT_USER_ID = (process.env.DISCONNECT_ALERT_USER_ID || '870201488218157107').trim();
const THRESHOLD = int(process.env.DISCONNECT_THRESHOLD, 15);
const WINDOW_MS = int(process.env.DISCONNECT_WINDOW_SECONDS, 30) * 1000;
const COOLDOWN_MS = int(process.env.DISCONNECT_COOLDOWN_MINUTES, 5) * 60 * 1000;
const ALERT_CHANNEL_ID = (process.env.DISCONNECT_ALERT_CHANNEL_ID || '').trim();
const ALERT_TEXT =
  process.env.DISCONNECT_ALERT_MESSAGE ||
  'ada apakah gerangan kawan, kok disconnect semua? Reset server atau kamu ke-disconnect? Coba cek ya.';

const TITLE_MATCH = 'player left server';

// channelId -> { events: [{ name, ts }], lastAlert }
const state = new Map();

const clean = (s) => String(s || '').replace(/[*_`~|]/g, '').trim();

function getUsername(embed, fallback) {
  const field = (embed.fields || []).find((f) => (f.name || '').toLowerCase().includes('username'));
  return clean(field?.value) || fallback;
}

module.exports = function initDisconnectAlert(client) {
  if (WATCH.size === 0) {
    console.log('[DisconnectAlert] Nonaktif: DISCONNECT_WATCH_CHANNEL_ID belum di-set.');
    return;
  }
  console.log(`[DisconnectAlert] Aktif di ${WATCH.size} channel: alert kalau > ${THRESHOLD} pemain keluar dalam ${WINDOW_MS / 1000} detik.`);

  let seq = 0;

  client.on('messageCreate', async (message) => {
    try {
      const channelId = message.channel?.id || message.channelId;
      if (!WATCH.has(channelId)) return;
      // Embed dari webhook / bot Server Monitor (bukan ketikan member, bukan pesan bot ini sendiri)
      if (!(message.webhookId || message.author?.bot)) return;
      if (message.author?.id && message.author.id === client.user?.id) return;

      const left = (message.embeds || []).find((e) => (e.title || '').toLowerCase().includes(TITLE_MATCH));
      if (!left) return;

      const now = Date.now();
      const st = state.get(channelId) || { events: [], lastAlert: 0 };
      state.set(channelId, st);

      st.events = st.events.filter((e) => now - e.ts <= WINDOW_MS);
      st.events.push({ name: getUsername(left, `?${++seq}`), ts: now });

      // Hitung pemain BERBEDA (username yang sama berkali-kali cuma dihitung sekali)
      const unique = new Set(st.events.map((e) => e.name.toLowerCase())).size;
      if (unique <= THRESHOLD) return;
      if (now - st.lastAlert < COOLDOWN_MS) return;

      st.lastAlert = now;
      st.events = [];

      const target = ALERT_CHANNEL_ID ? await client.channels.fetch(ALERT_CHANNEL_ID).catch(() => null) : message.channel;
      if (!target?.send) return;

      await target.send({
        content: `<@${ALERT_USER_ID}> ${ALERT_TEXT}\n📉 ${unique} pemain keluar dalam ${WINDOW_MS / 1000} detik terakhir.`,
        allowedMentions: { users: [ALERT_USER_ID] },
      });
    } catch (err) {
      console.error('[DisconnectAlert] Error:', err);
    }
  });
};
