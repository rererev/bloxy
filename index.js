// PTPT FAQ Bot (keyword matching + AI fallback gratis via Groq)
// Bot Discord yang otomatis jawab pertanyaan seputar order PTPT.
// Prioritas: cocokkan ke keyword di faq-data.json dulu (cepat & konsisten).
// Kalau gak ada keyword yang cocok, baru dilempar ke AI (Groq, gratis) yang
// dibekali isi faq-data.json sebagai konteks, biar jawabannya tetap nyambung
// ke topik PTPT dan gak ngasal.

require('dotenv').config();

const { Client, GatewayIntentBits, Partials, PermissionsBitField } = require('discord.js');
const { handleHoneypotMessage } = require('./honeypot');
const fs = require('fs');
const path = require('path');
const { handlePurgeCommand, containsSexualContent } = require('./moderation-extra');
const { handleExtraCommand, handleWarJoin, getDmSchedule, describeDmSchedule } = require('./bot-extras');
const { handleRoleToolsCommand } = require('./role-tools');

// ====== KONFIGURASI ======
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

// Folder tempat nulis file STATE (memory, reminders, slot-status, dll — yang bot tulis
// sendiri saat jalan). Kosong/gak di-set = pakai folder project ini sendiri (perilaku
// lama, cocok buat Wispbyte). Di Railway, set ini ke path Volume yang di-mount biar data
// gak ke-reset tiap kali re-deploy.
const DATA_DIR = process.env.DATA_DIR ? process.env.DATA_DIR : __dirname;

// Mastiin folder-nya ada (kalau pakai Volume yang masih kosong, folder tujuan bisa aja
// belum ada) — dibikin otomatis kalau belum ada, biar gak error pas nulis file pertama kali.
try {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log(`[DATA_DIR] Folder ${DATA_DIR} belum ada, otomatis dibikin.`);
  }
} catch (err) {
  console.error(`[DATA_DIR] Gagal mastiin folder ${DATA_DIR} ada:`, err.message || err);
}

// ====== KONFIGURASI AI FALLBACK (Groq — gratis) ======
// Daftar API key gratis di https://console.groq.com/keys
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
// Kalau API key belum diisi, AI fallback otomatis nonaktif (bot tetap jalan normal seperti sebelumnya).
const AI_FALLBACK_ENABLED = (process.env.AI_FALLBACK_ENABLED || 'true').toLowerCase() !== 'false' && GROQ_API_KEY.length > 0;
// Kalau true (default), AI cuma nyaut kalau bot di-mention/reply — biar gak ikut nyerocos
// di obrolan OOT yang emang gak ditujukan ke bot. Set "false" kalau mau AI tetap fallback
// ke SEMUA pesan yang gak match keyword FAQ (perilaku lama).
const AI_REQUIRE_MENTION = (process.env.AI_REQUIRE_MENTION || 'true').toLowerCase() !== 'false';
// Nama panggilan bot — kalau ada yang nyebut nama ini di chat, dianggap "manggil" bot
// juga (selain @mention/reply). Bisa lebih dari satu nama, pisah koma.
const BOT_NICKNAMES = (process.env.BOT_NICKNAMES || 'bloxy')
  .split(',')
  .map((n) => n.trim().toLowerCase())
  .filter(Boolean);

// ====== KONFIGURASI ANNOUNCEMENT ======
// Kalau ANNOUNCEMENT_CHANNEL_ID dikosongin, !umumin bakal post di channel tempat command diketik.
const ANNOUNCEMENT_CHANNEL_ID = process.env.ANNOUNCEMENT_CHANNEL_ID || '';
// Opsional: role yang di-mention tiap ada pengumuman baru (misal role "Member"). Bisa lebih dari satu, pisah koma.
const ANNOUNCEMENT_MENTION_ROLE_IDS = (process.env.ANNOUNCEMENT_MENTION_ROLE_ID || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

// ====== KONFIGURASI AUTO-MODERATION (ringan) ======
const AUTOMOD_ENABLED = (process.env.AUTOMOD_ENABLED || 'true').toLowerCase() !== 'false';
// Kata/frasa terlarang, pisah koma. Dicek sebagai substring (case-insensitive), jadi bisa
// isi frasa juga, misal: AUTOMOD_BANNED_WORDS=kasar1,kasar2,frasa jelek
const AUTOMOD_BANNED_WORDS = (process.env.AUTOMOD_BANNED_WORDS || '')
  .split(',')
  .map((w) => w.trim().toLowerCase())
  .filter(Boolean);
const AUTOMOD_BLOCK_INVITES = (process.env.AUTOMOD_BLOCK_INVITES || 'true').toLowerCase() !== 'false';
// Spam = lebih dari sekian pesan dalam sekian ms dari user yang sama.
const AUTOMOD_SPAM_THRESHOLD = parseInt(process.env.AUTOMOD_SPAM_THRESHOLD || '5', 10);
const AUTOMOD_SPAM_INTERVAL_MS = parseInt(process.env.AUTOMOD_SPAM_INTERVAL_MS || '7000', 10);

// ====== EMOJI CUSTOM BLOXY ======
// Makna tiap emoji (buat referensi pas nambah pemakaian baru):
// cheerful=ceria, confused/pmksd=bingung, ngantuk=ngantuk, excited=semangat,
// gemasss=gemas, lovely=lucu/gemas, hehe=ketawa kecil, ha=ketawa, ngambekgweh=ngambek,
// ngamuk=marah, surprised=kaget, ketjeh=keren, loplop=sayang/cinta, logo=logo Bloxy biasa
const EMOJI = {
  cheerful: '<:cheerfullbloxy:1550746270610755617>',
  confused: '<:confused:1550746293045952573>',
  pmksd: '<:pmksd:1550746522663256164>', // bingung
  ngantuk: '<:ngantuk:1550746495492427856>',
  excited: '<:excited:1550746206131585044>',
  gemasss: '<:gemasss:1550746320015335494>',
  lovely: '<:lovely:1550746414445764708>',
  hehe: '<:hehe:1550746366622306384>',
  ha: '<:ha:1550746344266661989>',
  ngambekgweh: '<:ngambekgweh:1550746442019115059>',
  ngamuk: '<:NGAMUKTOTHEMAX:1550746466992132158>', // marah
  surprised: '<:surprised:1550746546482712657>',
  ketjeh: '<:ketjeh:1550746390257475725>', // keren
  loplop: '<:loplop:1550746229523349614>', // sayang/cinta
  logo: '<:BloxylogoBOT:1550011261176258570>', // logo Bloxy biasa
};

// Daftar ini yang dikasih tau ke AI, biar dia bisa sesekali pake emoji custom
// (bukan emoji unicode biasa) di reply santainya — sparingly, gak tiap kalimat.
const EMOJI_LIST_FOR_AI = Object.entries({
  [EMOJI.cheerful]: 'ceria/senang',
  [EMOJI.pmksd]: 'bingung',
  [EMOJI.excited]: 'semangat',
  [EMOJI.gemasss]: 'gemas',
  [EMOJI.hehe]: 'ketawa kecil/nyengir',
  [EMOJI.ha]: 'ketawa',
  [EMOJI.ngamuk]: 'marah (bercanda)',
  [EMOJI.surprised]: 'kaget',
  [EMOJI.ketjeh]: 'keren',
  [EMOJI.loplop]: 'sayang/gemas',
})
  .map(([tag, meaning]) => `${tag} = ${meaning}`)
  .join(', ');

// Tracker spam disimpan di memory (reset kalau bot restart — gak masalah, cuma buat deteksi jangka pendek).
const spamTracker = new Map();

// ====== KONFIGURASI PLAYER MONITOR (baca embed "Check Player" dari BLOX Gank) ======
// Channel tempat embed "Check Player On Server ..." dari BLOX Gank di-post. Bisa lebih
// dari satu, pisah koma. Kosongin = dengerin di semua channel (gak disaranin, boros proses).
const PLAYER_MONITOR_CHANNEL_IDS = (process.env.PLAYER_MONITOR_CHANNEL_ID || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

// Data lokasi player terakhir yang ke-capture, key = username (lowercase).
// Disimpan di memory aja (bukan file) — datanya emang cuma valid sesaat, gak perlu persist.
const playerLocationData = new Map();

// ====== KONFIGURASI ACCESS REMINDER (!kasihakses — DM otomatis Minggu jam 08.00 WIB) ======
const ACCESS_DATA_PATH = path.join(DATA_DIR, 'access-schedule.json');
// Reminder terakhir dikirim (tanggal WIB, format YYYY-MM-DD) — biar gak double-kirim
// dalam window menit yang sama.
let lastAccessReminderDateKey = null;

// ====== KONFIGURASI GENERAL REMINDER (!reminder — bebas, sekali atau harian) ======
const REMINDER_DATA_PATH = path.join(DATA_DIR, 'reminders.json');

// ====== KONFIGURASI MEMORY (info tambahan yang cuma bisa disimpan user tertentu) ======
// Isi dengan User ID Discord (angka panjang, klik kanan profil > Copy User ID,
// perlu aktifkan Developer Mode dulu di Discord). Pisahkan dengan koma kalau lebih dari satu.
const MEMORY_ADMIN_USER_IDS = (process.env.MEMORY_ADMIN_USER_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

const MEMORY_DATA_PATH = path.join(DATA_DIR, 'memory-data.json');

// ====== KONFIGURASI MODE DIAM (!diam / !kembali bicara) ======
const SILENCE_STATE_PATH = path.join(DATA_DIR, 'silence-state.json');
let isBotSilenced = false; // di-load ulang dari file pas bot start (lihat client.once('ready'))

// Channel tempat bot ini aktif mendengarkan pertanyaan (pisahkan koma kalau lebih dari satu)
const ALLOWED_CHANNEL_IDS = (process.env.ALLOWED_CHANNEL_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

// Channel tempat embed "LIST PTPT AKTIF" (Server 1 & Server 2) di-pin/di-update.
// Bisa 1 channel atau lebih, pisahkan dengan koma.
const AUTOLIST_CHANNEL_IDS = (process.env.AUTOLIST_CHANNEL_ID || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

// ====== KONFIGURASI SLOT ALERT (notif otomatis pas slot kosong lagi) ======
// Channel tujuan alert. Kosongin = pakai channel autolist yang pertama di AUTOLIST_CHANNEL_ID.
const SLOT_ALERT_CHANNEL_ID = process.env.SLOT_ALERT_CHANNEL_ID || '';
// Role yang di-tag tiap ada slot kosong lagi. Bisa lebih dari satu, pisah koma.
const SLOT_ALERT_ROLE_IDS = (process.env.SLOT_ALERT_ROLE_ID || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

// Status slot terakhir per server (key: "Server 1"/"Server 2"), buat bandingin
// apakah barusan pindah dari FULL ke ada-slot. Disimpan ke FILE (bukan cuma memory),
// biar gak reset tiap kali bot restart (baseline ilang = alert pertama sering ke-skip).
const SLOT_STATUS_PATH = path.join(DATA_DIR, 'slot-status.json');

function loadSlotStatus() {
  try {
    if (!fs.existsSync(SLOT_STATUS_PATH)) return new Map();
    const raw = fs.readFileSync(SLOT_STATUS_PATH, 'utf-8');
    const data = JSON.parse(raw);
    return new Map(Object.entries(data));
  } catch (err) {
    console.error('Gagal load slot-status.json:', err);
    return new Map();
  }
}

function saveSlotStatus(map) {
  try {
    const obj = Object.fromEntries(map);
    fs.writeFileSync(SLOT_STATUS_PATH, JSON.stringify(obj, null, 2), 'utf-8');
  } catch (err) {
    console.error('Gagal simpan slot-status.json:', err);
  }
}

const lastKnownSlotStatus = loadSlotStatus();

// ====== KONFIGURASI AUTO-REACT (react emoji otomatis di channel tertentu) ======
const AUTOREACT_CHANNEL_IDS = (process.env.AUTOREACT_CHANNEL_ID || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);
// Minimal 2 emoji, pisah koma. Bisa unicode (👍) atau custom Discord (<:nama:id>).
const AUTOREACT_EMOJIS = (process.env.AUTOREACT_EMOJIS || `${EMOJI.excited},${EMOJI.gemasss}`)
  .split(',')
  .map((e) => e.trim())
  .filter(Boolean);

// ====== KONFIGURASI AUTO-TRANSLATE (channel sumber → auto-translate ke Indonesia) ======
// Channel sumber (bahasa apapun) yang mau di-translate. Bisa lebih dari satu, pisah koma.
const TRANSLATE_SOURCE_CHANNEL_IDS = (process.env.TRANSLATE_SOURCE_CHANNEL_ID || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);
// Channel tujuan hasil translate. Urutan harus sama sama TRANSLATE_SOURCE_CHANNEL_ID
// (channel sumber ke-1 → channel tujuan ke-1, dst). Kalau cuma isi 1 channel tujuan
// tapi source-nya lebih dari 1, semua source bakal nge-output ke channel tujuan itu aja.
const TRANSLATE_TARGET_CHANNEL_IDS = (process.env.TRANSLATE_TARGET_CHANNEL_ID || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

// Cooldown per user (detik) — biar orang yang spam keyword yang sama gak dibalas
// berkali-kali dalam waktu singkat. Default 10 detik kalau env var gak di-set.
const COOLDOWN_SECONDS = parseInt(process.env.COOLDOWN_SECONDS || '10', 10);

// Menyimpan kapan terakhir tiap user dapat balasan dari bot (di memory, reset saat bot restart)
const lastReplyTimestamp = new Map();

function isOnCooldown(userId) {
  const last = lastReplyTimestamp.get(userId);
  if (!last) return false;
  const elapsedSeconds = (Date.now() - last) / 1000;
  return elapsedSeconds < COOLDOWN_SECONDS;
}

function markReplied(userId) {
  lastReplyTimestamp.set(userId, Date.now());
}

// Channel tempat blox-gank-bot posting notif "Forgotten Tier Detected!" (bisa lebih dari satu, pisah koma)
// ====== KONFIGURASI DELETE LOG (log pesan yang dihapus) ======
// Channel tujuan log. Kosongin = fitur ini nonaktif.
const DELETE_LOG_CHANNEL_IDS = (process.env.DELETE_LOG_CHANNEL_ID || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

const FORGOTTEN_WATCH_CHANNEL_IDS = (process.env.FORGOTTEN_WATCH_CHANNEL_ID || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

const FORGOTTEN_TITLE = 'forgotten tier detected';

const FAQ_DATA_PATH = path.join(__dirname, 'faq-data.json');

// ====== LOAD FAQ DATA ======
function loadFaqData() {
  try {
    const raw = fs.readFileSync(FAQ_DATA_PATH, 'utf-8');
    const data = JSON.parse(raw);

    // Validasi tiap item, biar ketahuan di log kalau ada yang formatnya salah
    // (misal field "keyword" kelupaan atau kosong) tanpa bikin bot crash.
    data.forEach((item, i) => {
      if (!item || typeof item.keyword !== 'string' || item.keyword.trim() === '') {
        console.warn(
          `[PERINGATAN] faq-data.json item ke-${i + 1} gak punya "keyword" yang valid, item ini dilewati:`,
          JSON.stringify(item)
        );
      }
    });

    return data;
  } catch (err) {
    console.error('Gagal load faq-data.json:', err);
    return [];
  }
}

// ====== CEK STATUS SLOT DARI CHANNEL AUTOLIST ======
// Bot scan pesan-pesan terbaru di AUTOLIST_CHANNEL_ID, cari embed yang judulnya
// mengandung "Server 1" / "Server 2", lalu ambil baris "Terisi: X/Y slot" dari embed itu.
function extractSlotCount(embed) {
  // Gabungkan semua kemungkinan lokasi teks di embed jadi satu string,
  // biar gak peduli "Terisi: X/Y slot" itu ada di description, field, atau footer.
  const parts = [
    embed.title || '',
    embed.description || '',
    embed.footer?.text || '',
    ...(embed.fields || []).map((f) => `${f.name} ${f.value}`),
  ];
  const combined = parts.join(' ');

  const match = combined.match(/terisi\s*:?\s*(\d+)\s*\/\s*(\d+)\s*slot/i);
  if (!match) return null;

  return { filled: parseInt(match[1], 10), total: parseInt(match[2], 10) };
}

// ====== SLOT ALERT: notif otomatis begitu status pindah dari FULL ke ada-slot ======

async function sendSlotAlert(client, serverLabel, slotInfo) {
  const sisa = slotInfo.total - slotInfo.filled;
  const targetChannelId = SLOT_ALERT_CHANNEL_ID || AUTOLIST_CHANNEL_IDS[0];
  if (!targetChannelId) return;

  try {
    const channel = await client.channels.fetch(targetChannelId);
    const roleMentions = SLOT_ALERT_ROLE_IDS.map((id) => `<@&${id}>`).join(' ');

    const lines = [];
    if (roleMentions) lines.push(roleMentions);
    lines.push(`${EMOJI.excited} **${serverLabel}** ada yang order! Sisa ${sisa}/${slotInfo.total} slot kosong ${EMOJI.gemasss}`);
    if (sisa > 0) {
      lines.push('Buruan order sebelum penuh!');
    } else {
      lines.push('Server FULL sekarang — ditunggu next open yaa!');
    }

    await channel.send({ content: lines.join('\n') });
    console.log(`[SlotAlert] Kirim notif: ${serverLabel} sisa ${sisa}/${slotInfo.total}`);
  } catch (err) {
    console.error('Gagal kirim alert slot kosong:', err);
  }
}

// Dipanggil tiap ada pesan baru ATAU pesan di-edit di channel autolist.
// Bandingin status slot terbaru vs yang tersimpan sebelumnya — kalau baru aja pindah
// dari FULL (sisa <= 0) ke ada slot (sisa > 0), kirim alert.
async function handlePossibleAutolistUpdate(client, message) {
  if (AUTOLIST_CHANNEL_IDS.length === 0) return;
  if (!AUTOLIST_CHANNEL_IDS.includes(message.channel.id)) return;

  console.log(`[SlotAlert][DEBUG] Pesan masuk/edit di channel autolist (${message.channel.id}), jumlah embed: ${message.embeds?.length || 0}`);

  if (!message.embeds || message.embeds.length === 0) return;

  for (const embed of message.embeds) {
    console.log(`[SlotAlert][DEBUG] Embed title: "${embed.title || '(kosong)'}"`);
    const title = (embed.title || '').toLowerCase();
    if (!title.includes('list ptpt aktif')) {
      console.log('[SlotAlert][DEBUG] Title gak cocok "list ptpt aktif", skip embed ini.');
      continue;
    }

    let label = null;
    if (title.includes('server 1')) label = 'Server 1';
    else if (title.includes('server 2')) label = 'Server 2';

    // Fallback: kalau title gak nyebut nomor server eksplisit, tebak dari channel-nya —
    // channel pertama di AUTOLIST_CHANNEL_ID = Server 1, channel kedua = Server 2.
    if (!label) {
      const channelIndex = AUTOLIST_CHANNEL_IDS.indexOf(message.channel.id);
      if (channelIndex === 0) label = 'Server 1';
      else if (channelIndex === 1) label = 'Server 2';
    }

    if (!label) {
      console.log('[SlotAlert][DEBUG] Gagal nentuin label server (title & channel index gak match), skip.');
      continue;
    }

    const slotInfo = extractSlotCount(embed);
    if (!slotInfo) {
      console.log('[SlotAlert][DEBUG] Title cocok tapi gagal extract "Terisi: X/Y slot". RAW description:', JSON.stringify(embed.description || '(kosong)'));
      console.log('[SlotAlert][DEBUG] RAW fields:', JSON.stringify(embed.fields || []));
      continue;
    }

    const prev = lastKnownSlotStatus.get(label);
    lastKnownSlotStatus.set(label, slotInfo);
    saveSlotStatus(lastKnownSlotStatus);

    console.log(`[SlotAlert][DEBUG] ${label}: sebelumnya=${prev ? `${prev.filled}/${prev.total}` : '(belum ada baseline)'}, sekarang=${slotInfo.filled}/${slotInfo.total}`);

    // Baseline pertama (bot baru nyala) — simpan aja, jangan langsung alert.
    if (!prev) {
      console.log(`[SlotAlert][DEBUG] ${label} baru pertama kali ke-capture (baseline), belum alert.`);
      continue;
    }

    // Alert tiap kali ADA SLOT BARU KEISI (filled bertambah) — gak perlu nunggu
    // dari FULL dulu, langsung notif tiap ada yang order + sisa slot kosongnya.
    if (slotInfo.filled > prev.filled) {
      await sendSlotAlert(client, label, slotInfo);
    }
  }
}

// ====== AUTO-TRANSLATE: channel sumber (bahasa apapun) → translate ke Indonesia ======
async function translateToIndonesian(text) {
  if (!GROQ_API_KEY) return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'Kamu penerjemah. Terjemahkan pesan dari user ke Bahasa Indonesia yang natural dan santai. Kalau pesannya udah Bahasa Indonesia, balas PERSIS sama persis tanpa diubah. Balas HANYA hasil terjemahannya — tanpa tanda kutip, tanpa penjelasan, tanpa embel-embel apapun.',
          },
          { role: 'user', content: text },
        ],
        max_tokens: 500,
        temperature: 0.3,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.error(`Groq translate error (${response.status}):`, await response.text().catch(() => ''));
      return null;
    }

    const data = await response.json();
    return data?.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.error('Gagal panggil Groq buat translate:', err.message || err);
    return null;
  }
}

async function handlePossibleTranslate(client, message) {
  if (TRANSLATE_SOURCE_CHANNEL_IDS.length === 0) return;
  const sourceIndex = TRANSLATE_SOURCE_CHANNEL_IDS.indexOf(message.channel.id);
  if (sourceIndex === -1) return;
  // Skip bot Discord beneran, tapi izinin webhook (misal pesan dari bot order/announcement
  // yang post via webhook) — sama kayak alasan di handleAutoReact.
  if (message.author.bot && !message.webhookId) return;

  const text = message.content.trim();
  if (!text) return; // pesan kosong (cuma gambar/attachment doang) — skip

  const targetChannelId = TRANSLATE_TARGET_CHANNEL_IDS[sourceIndex] || TRANSLATE_TARGET_CHANNEL_IDS[0];
  if (!targetChannelId) {
    console.error('[Translate] TRANSLATE_TARGET_CHANNEL_ID belum di-set, skip translate.');
    return;
  }

  const translated = await translateToIndonesian(text);
  if (!translated) return;

  try {
    const targetChannel = await client.channels.fetch(targetChannelId);
    await targetChannel.send(translated);
  } catch (err) {
    console.error('[Translate] Gagal kirim hasil translate:', err);
  }
}

// ====== AUTO-REACT: react emoji otomatis di channel tertentu ======
async function handleAutoReact(message) {
  if (AUTOREACT_CHANNEL_IDS.length === 0) {
    console.log('[AutoReact][DEBUG] AUTOREACT_CHANNEL_ID kosong, fitur ini nonaktif.');
    return;
  }
  if (!AUTOREACT_CHANNEL_IDS.includes(message.channel.id)) return;
  // Skip pesan dari bot Discord beneran, TAPI izinin pesan dari webhook (misal bot order/
  // announcement yang post via webhook) — webhook message punya author.bot=true juga di
  // Discord API, padahal itu bukan "bot" dalam artian yang mau kita skip di sini.
  if (message.author.bot && !message.webhookId) return;

  console.log(`[AutoReact][DEBUG] Pesan masuk di channel ter-monitor (${message.channel.id}), mau react ${AUTOREACT_EMOJIS.length} emoji: ${AUTOREACT_EMOJIS.join(', ')}`);

  for (const emoji of AUTOREACT_EMOJIS) {
    try {
      await message.react(emoji);
      console.log(`[AutoReact][DEBUG] Berhasil react: ${emoji}`);
    } catch (err) {
      console.error(`[AutoReact][DEBUG] GAGAL react emoji "${emoji}":`, err.message || err);
    }
  }
}

async function getSlotStatusReply(client) {
  if (AUTOLIST_CHANNEL_IDS.length === 0) {
    return 'Duh, channel autolist belum di-set di konfigurasi bot. Cek admin ya 🙏';
  }

  try {
    let server1 = null;
    let server2 = null;

    // Scan tiap channel yang di-set — bisa 1 channel isi 2 embed, atau 2 channel terpisah.
    for (const channelId of AUTOLIST_CHANNEL_IDS) {
      if (server1 && server2) break;

      const channel = await client.channels.fetch(channelId);
      const messages = await channel.messages.fetch({ limit: 50 });

      // Cari embed per server dari pesan-pesan yang ada (biasanya pesan bot yang di-edit terus,
      // jadi urutan gak selalu paling atas — makanya kita scan semua yang ke-fetch).
      for (const msg of messages.values()) {
        for (const embed of msg.embeds) {
          const title = (embed.title || '').toLowerCase();
          if (!title.includes('list ptpt aktif')) continue;

          const slotInfo = extractSlotCount(embed);
          if (!slotInfo) continue;

          if (title.includes('server 1') && !server1) server1 = slotInfo;
          if (title.includes('server 2') && !server2) server2 = slotInfo;
        }
        if (server1 && server2) break;
      }
    }

    if (!server1 && !server2) {
      return 'Hmm, gak nemu list slot-nya di channel autolist. Coba cek manual dulu ya 🙏';
    }

    const describe = (label, info) => {
      if (!info) return `${label}: data gak ketemu`;
      const sisa = info.total - info.filled;
      if (sisa <= 0) {
        return `${label} FULL (${info.filled}/${info.total}) 😭`;
      }
      return `${label} masih ada ${sisa} slot kosong (${info.filled}/${info.total}) 🎣`;
    };

    return `${describe('Server 1', server1)}\n${describe('Server 2', server2)}`;
  } catch (err) {
    console.error('Gagal cek status slot dari autolist:', err);
    return 'Duh, gagal cek slot-nya nih, coba lagi bentar ya 🙏';
  }
}

// Kalau jawaban berupa array (banyak variasi), pilih satu secara acak.
// Kalau cuma string biasa, pakai langsung.
function pickAnswer(jawaban) {
  if (Array.isArray(jawaban)) {
    if (jawaban.length === 0) return null;
    const idx = Math.floor(Math.random() * jawaban.length);
    return jawaban[idx];
  }
  return jawaban;
}

// ====== NORMALISASI TEKS ======
// Supaya pencocokan tidak sensitif ke huruf besar/kecil, tanda baca, atau spasi ganda.
function normalize(text) {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s]/g, ' ') // buang tanda baca
    .replace(/\s+/g, ' ')
    .trim();
}

// Kata-kata pengisi yang sering muncul di chat santai tapi gak nentuin makna,
// jadi diabaikan waktu ngukur "seberapa cocok" alias sama pesan user.
const STOPWORDS = new Set([
  'iya', 'ya', 'yah', 'sih', 'dong', 'nih', 'deh', 'ga', 'gak', 'gk', 'nggak',
  'kah', 'ada', 'apa', 'di', 'ke', 'yang', 'itu', 'ini', 'aja', 'kok', 'gan',
  'min', 'kak', 'bang', 'ci', 'ka', 'tuh',
]);

// Cek dua kata "cukup mirip" — exact match, atau salah satu adalah awalan kata yang lain
// (biar "kapan" cocok sama "kapannya", "server" cocok sama "servernya", dst).
function wordsMatch(a, b) {
  if (a === b) return true;
  if (a.length >= 4 && b.length >= 4) {
    return a.startsWith(b) || b.startsWith(a);
  }
  return false;
}

// ====== CARI FAQ YANG COCOK ======
// Setiap item FAQ boleh punya satu atau beberapa keyword/alias, dipisah koma di faq-data.json.
// Pencocokan: alias dianggap cocok kalau semua kata PENTING (bukan stopword) di alias itu
// ketemu padanannya di pesan user (boleh beda imbuhan dikit, lihat wordsMatch).
// Contoh: alias "kapan iya" cocok untuk pesan "ini kapan ya bisa order lagi"
function findAnswer(faqData, userMessage) {
  const normalizedMessage = normalize(userMessage);
  const messageWords = normalizedMessage.split(' ').filter(Boolean);

  let bestMatch = null;
  let bestScore = 0;

  for (const item of faqData) {
    // Lewati item yang rusak/gak punya "keyword" valid, biar bot gak crash gara-gara
    // satu entry salah format di faq-data.json.
    if (!item || typeof item.keyword !== 'string' || item.keyword.trim() === '') {
      continue;
    }

    // keyword bisa berupa string tunggal atau dipisah koma untuk beberapa alias
    const aliases = item.keyword.split(',').map((k) => normalize(k.trim()));

    for (const alias of aliases) {
      const aliasWords = alias.split(' ').filter(Boolean);
      if (aliasWords.length === 0) continue;

      // Kata penting = bukan stopword. Kalau semua kata di alias ternyata stopword,
      // pakai semua kata alias itu (biar tetap ada yang dicek, walau jarang terjadi).
      const importantWords = aliasWords.filter((w) => !STOPWORDS.has(w));
      const wordsToCheck = importantWords.length > 0 ? importantWords : aliasWords;

      const allWordsPresent = wordsToCheck.every((aw) =>
        messageWords.some((mw) => wordsMatch(aw, mw))
      );

      if (allWordsPresent) {
        // Skor = jumlah kata penting — alias yang lebih spesifik menang kalau ada
        // beberapa FAQ yang sama-sama cocok.
        const score = wordsToCheck.length;
        if (score > bestScore) {
          bestScore = score;
          bestMatch = item;
        }
      }
    }
  }

  return bestMatch;
}

// ====== AI FALLBACK (Groq — dipanggil kalau keyword FAQ gak ada yang cocok) ======

// Ringkas isi faq-data.json jadi teks konteks singkat, biar AI tau info yang
// sudah "resmi" dan gak mengarang jawaban di luar itu.
function buildFaqContext(faqData) {
  const lines = [];
  for (const item of faqData) {
    if (!item || typeof item.keyword !== 'string' || item.keyword.trim() === '') continue;
    if (item.dynamic) continue; // yang dynamic (misal slot_status) gak perlu masuk konteks teks
    const jawaban = Array.isArray(item.jawaban) ? item.jawaban[0] : item.jawaban;
    if (!jawaban) continue;
    lines.push(`- Topik "${item.keyword.split(',')[0].trim()}": ${jawaban}`);
  }
  return lines.join('\n');
}

const SYSTEM_PROMPT_TEMPLATE = `Kamu adalah Bloxy, member biasa di server Discord komunitas Roblox yang juga jadi asisten FAQ soal order "PTPT" (event/tournament Roblox).
Gaya bahasa: santai, gaul, singkat, kayak ngobrol biasa — bukan formal.
Berikut daftar info resmi soal PTPT yang kamu tau (jadikan acuan KALAU relevan):
{FAQ_CONTEXT}

Kamu punya emoji custom sendiri yang boleh SESEKALI dipakai di reply (jangan tiap kalimat,
cukup kalau pas momennya) — pakai PERSIS tag-nya (termasuk tanda <> dan angka ID-nya), JANGAN
diketik ulang jadi teks biasa: {EMOJI_LIST}

Aturan PENTING:
- Kalau pertanyaan/obrolan user gak ada hubungannya sama PTPT sama sekali (basa-basi, curhat, topik lain, dll), JANGAN paksa nyambungin ke PTPT atau nawarin info PTPT — jawab santai aja sesuai konteks obrolan, kayak temen ngobrol biasa.
- Cuma pakai info PTPT di atas KALAU pertanyaannya memang soal PTPT/order/event ini.
- Kalau gak yakin atau butuh info spesifik yang gak ada di atas (misal status order pribadi), jujur bilang gak tau/saranin tanya admin/buat ticket — jangan ngarang.
- Jawaban singkat aja, 1-3 kalimat, jangan bertele-tele.`;

// Budget token jawaban AI. Model "openai/gpt-oss-*" itu model REASONING: dia "mikir" dulu dan
// token mikirnya ikut kehitung ke batas ini. Kalau batasnya terlalu kecil, token habis sebelum
// sempat nulis jawaban → isi jawaban kosong → bot jadi diam. Makanya default-nya dibesarkan.
const GROQ_MAX_TOKENS = parseInt(process.env.GROQ_MAX_TOKENS || '1200', 10);
// Balasan kalau AI gagal jawab padahal bot jelas lagi dipanggil (biar gak diam aja).
const AI_FAIL_REPLY = process.env.AI_FAIL_REPLY || 'Duh, otakku lagi nge-lag bentar 😅 coba tanya lagi yaa';

async function callGroqOnce(systemPrompt, userQuestion, maxTokens) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000); // 20 detik timeout
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userQuestion },
        ],
        max_completion_tokens: maxTokens,
        temperature: 0.7,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      const retryAfter = parseFloat(response.headers?.get?.('retry-after')) || 0;
      return { ok: false, status: response.status, retryAfter, errText };
    }

    const data = await response.json();
    const choice = data?.choices?.[0];
    const reply = choice?.message?.content?.trim();
    if (!reply) {
      return { ok: false, status: 200, empty: true, finish: choice?.finish_reason, usage: data?.usage };
    }
    return { ok: true, reply };
  } catch (err) {
    return { ok: false, status: 0, error: err?.name === 'AbortError' ? 'timeout (>20 detik)' : err?.message || String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

async function askGroqAI(faqData, memoryData, userQuestion) {
  if (!AI_FALLBACK_ENABLED) return null;

  const faqContext = buildFaqContext(faqData);
  const memoryContext = buildMemoryContext(memoryData);
  const fullContext = memoryContext
    ? `${faqContext}\n\nInfo tambahan yang disimpan admin:\n${memoryContext}`
    : faqContext;

  const systemPrompt = SYSTEM_PROMPT_TEMPLATE.replace('{FAQ_CONTEXT}', fullContext).replace('{EMOJI_LIST}', EMOJI_LIST_FOR_AI);

  let maxTokens = GROQ_MAX_TOKENS;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await callGroqOnce(systemPrompt, userQuestion, maxTokens);
    if (r.ok) return r.reply;

    // Catat penyebab yang jelas di log Railway supaya gampang dilacak
    if (r.empty) {
      console.error(`[AI] Percobaan ${attempt}: jawaban kosong (finish_reason=${r.finish}, usage=${JSON.stringify(r.usage || {})}). Kalau finish_reason=length, token habis buat "mikir" — naikkan GROQ_MAX_TOKENS.`);
    } else if (r.status) {
      console.error(`[AI] Percobaan ${attempt}: Groq error ${r.status}: ${String(r.errText || '').slice(0, 300)}`);
    } else {
      console.error(`[AI] Percobaan ${attempt}: gagal panggil Groq: ${r.error}`);
    }

    if (attempt === 2) break;
    // Error permanen (key salah, request salah) gak usah diulang
    if (r.status >= 400 && r.status < 500 && r.status !== 429) break;

    if (r.empty && r.finish === 'length') maxTokens = Math.min(maxTokens * 2, 4000);
    const waitMs = r.status === 429 ? Math.min((r.retryAfter || 2) * 1000, 6000) : 1000;
    await new Promise((res) => setTimeout(res, waitMs));
  }
  return null;
}

// ====== ANNOUNCEMENT: !umumin <teks> (khusus Administrator) ======
async function handleAnnounceCommand(message, content) {
  if (!isAdministrator(message)) {
    await message.reply('Command ini cuma buat Administrator yaa 🙏');
    return;
  }

  const teks = content.replace(/^!umumin\s*/i, '').trim();
  if (!teks) {
    await message.reply('Formatnya: `!umumin <isi pengumuman>`');
    return;
  }

  const targetChannel = ANNOUNCEMENT_CHANNEL_ID
    ? await message.guild.channels.fetch(ANNOUNCEMENT_CHANNEL_ID).catch(() => null)
    : message.channel;

  if (!targetChannel) {
    await message.reply('Channel announcement gak ketemu, cek lagi `ANNOUNCEMENT_CHANNEL_ID` di `.env` yaa.');
    return;
  }

  // Role mention: gabungin semua role ID jadi beberapa tag terpisah, misal "<@&111> <@&222>"
  // (Discord gak bisa parse satu tag isi banyak ID sekaligus kayak "<@&111,222>").
  const mentionText = ANNOUNCEMENT_MENTION_ROLE_IDS.length > 0
    ? ANNOUNCEMENT_MENTION_ROLE_IDS.map((id) => `<@&${id}>`).join(' ')
    : '';

  // Plain text (bukan embed) — biar gak ada bagian yang keliatan "bisa diklik" padahal enggak.
  const lines = [];
  if (mentionText) lines.push(mentionText);
  lines.push('📣 **Pengumuman**', '', teks, '', `_Diumumkan oleh ${message.author.tag}_`);

  const announcementText = lines.join('\n');

  try {
    await targetChannel.send({ content: announcementText });
    if (targetChannel.id !== message.channel.id) {
      await message.reply(`Oke, pengumuman udah dikirim ke <#${targetChannel.id}> ✅ ${EMOJI.ketjeh}`);
    }
  } catch (err) {
    console.error('Gagal kirim pengumuman:', err);
    await message.reply('Duh, gagal kirim pengumumannya. Cek permission bot di channel itu yaa (perlu izin Send Messages).');
  }
}

// ====== AUTO-MODERATION (ringan): kata terlarang, link invite, spam ======
const INVITE_LINK_REGEX = /(discord\.gg\/[a-zA-Z0-9-]+|discord(?:app)?\.com\/invite\/[a-zA-Z0-9-]+)/i;
const GENERIC_URL_REGEX = /https?:\/\/[^\s]+/i;

// Kata kunci umum yang sering muncul di scam giveaway (MrBeast palsu, nitro gratis, dll)
// yang biasa disebar akun ke-compromise. Bisa ditambah lewat AUTOMOD_SCAM_KEYWORDS di .env.
const DEFAULT_SCAM_KEYWORDS = [
  'mrbeast', 'mr beast', 'free nitro', 'nitro gratis', 'steamcommunity',
  'airdrop', 'claim your gift', 'you won', 'you have won', 'giveaway winner',
  'discord nitro free', 'free robux', 'robux gratis', 'sub4sub', 'free gift',
];
const AUTOMOD_SCAM_KEYWORDS = [
  ...DEFAULT_SCAM_KEYWORDS,
  ...(process.env.AUTOMOD_SCAM_KEYWORDS || '')
    .split(',')
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean),
];

// Set "false" di .env kalau deteksi ini kerasa kebablasan (misal ada yang wajar kirim
// bukti bayar berupa screenshot + link).
const AUTOMOD_BLOCK_MEDIA_LINK_SPAM = (process.env.AUTOMOD_BLOCK_MEDIA_LINK_SPAM || 'true').toLowerCase() !== 'false';

// Pola khas scam: ada LINK, DAN (ada lampiran gambar ATAU nyebut kata kunci giveaway-scam).
// Kombinasi ini dipilih biar gak asal flag orang share link biasa doang.
function looksLikeScamSpam(message) {
  if (!AUTOMOD_BLOCK_MEDIA_LINK_SPAM) return false;

  const content = message.content || '';
  if (!GENERIC_URL_REGEX.test(content)) return false;

  const hasAttachment = message.attachments && message.attachments.size > 0;
  const lower = content.toLowerCase();
  const hasScamKeyword = AUTOMOD_SCAM_KEYWORDS.some((kw) => lower.includes(kw));

  return hasAttachment || hasScamKeyword;
}

function containsBannedWord(content) {
  const lower = content.toLowerCase();
  return AUTOMOD_BANNED_WORDS.find((word) => lower.includes(word)) || null;
}

async function warnAndDelete(message, reasonText) {
  try {
    await message.delete();
  } catch (err) {
    console.error('Gagal hapus pesan (cek permission Manage Messages bot):', err.message || err);
  }
  try {
    const warn = await message.channel.send(`${EMOJI.ngambekgweh} <@${message.author.id}>, ${reasonText}`);
    setTimeout(() => warn.delete().catch(() => {}), 6000);
  } catch (err) {
    console.error('Gagal kirim warning automod:', err);
  }
}

function isSpamming(userId) {
  const now = Date.now();
  const timestamps = (spamTracker.get(userId) || []).filter((t) => now - t < AUTOMOD_SPAM_INTERVAL_MS);
  timestamps.push(now);
  spamTracker.set(userId, timestamps);
  return timestamps.length > AUTOMOD_SPAM_THRESHOLD;
}

// Return true kalau pesan udah ditangani (dihapus) oleh automod — caller harus stop proses lebih lanjut.
async function checkAutoMod(message) {
  if (!AUTOMOD_ENABLED) return false;
  if (isAdministrator(message)) return false; // admin dikecualikan dari filter

  const content = message.content;

  const bannedWord = containsBannedWord(content);
  if (bannedWord) {
    await warnAndDelete(message, 'tolong jaga kata-kata yaa di sini 🙏');
    return true;
  }

  if (containsSexualContent(content)) {
    await warnAndDelete(message, 'konten seperti itu gak boleh di sini yaa, pesanmu otomatis dihapus 🙏');
    return true;
  }

  if (looksLikeScamSpam(message)) {
    await warnAndDelete(message, `pesan kamu ke-detect mirip pola scam/giveaway palsu (gambar/kata kunci + link), jadi otomatis dihapus. Kalau ini keliru, hubungi admin yaa ${EMOJI.confused}`);
    return true;
  }

  if (AUTOMOD_BLOCK_INVITES && INVITE_LINK_REGEX.test(content)) {
    await warnAndDelete(message, 'link invite Discord gak boleh di-share di sini yaa 🙏');
    return true;
  }

  if (isSpamming(message.author.id)) {
    await warnAndDelete(message, 'pelan-pelan yaa ngirim pesannya, jangan spam 🙏');
    return true;
  }

  return false;
}

// ====== MODE DIAM: !diam / !kembali bicara (khusus Administrator) ======

function loadSilenceState() {
  try {
    if (!fs.existsSync(SILENCE_STATE_PATH)) return false;
    const raw = fs.readFileSync(SILENCE_STATE_PATH, 'utf-8');
    const data = JSON.parse(raw);
    return Boolean(data?.silenced);
  } catch (err) {
    console.error('Gagal load silence-state.json:', err);
    return false;
  }
}

function saveSilenceState(silenced) {
  try {
    fs.writeFileSync(SILENCE_STATE_PATH, JSON.stringify({ silenced }, null, 2), 'utf-8');
  } catch (err) {
    console.error('Gagal simpan silence-state.json:', err);
  }
}

async function handleSilenceCommand(message, silence) {
  if (!isAdministrator(message)) {
    await message.reply('Command ini cuma buat Administrator yaa 🙏');
    return;
  }

  isBotSilenced = silence;
  saveSilenceState(isBotSilenced);

  if (silence) {
    await message.reply(`Oke, aku diem dulu ya ${EMOJI.ngantuk} (panggil \`!kembali bicara\` kalau udah boleh ngomong lagi)`);
  } else {
    await message.reply(`Oke aku balik lagi! ${EMOJI.excited}`);
  }
}

// ====== MEMORY: SIMPAN INFO TAMBAHAN (cuma user tertentu) ======

function isAllowedToManageMemory(message) {
  // Kalau MEMORY_ADMIN_USER_IDS belum di-set sama sekali, DEFAULT-nya nobody boleh
  // (lebih aman daripada kebuka buat semua orang secara gak sengaja).
  if (MEMORY_ADMIN_USER_IDS.length === 0) return false;
  return MEMORY_ADMIN_USER_IDS.includes(message.author.id);
}

function loadMemoryData() {
  try {
    if (!fs.existsSync(MEMORY_DATA_PATH)) return [];
    const raw = fs.readFileSync(MEMORY_DATA_PATH, 'utf-8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error('Gagal load memory-data.json:', err);
    return [];
  }
}

function saveMemoryData(data) {
  try {
    fs.writeFileSync(MEMORY_DATA_PATH, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('Gagal simpan memory-data.json:', err);
    return false;
  }
}

function buildMemoryContext(memoryData) {
  if (!memoryData || memoryData.length === 0) return '';
  return memoryData.map((m) => `- ${m.teks}`).join('\n');
}

// ====== COMMAND MEMORY: !ingat <teks> ======
async function handleRememberCommand(message, content) {
  if (!isAllowedToManageMemory(message)) {
    await message.reply('Command ini cuma buat orang tertentu yaa 🙏');
    return;
  }

  const teks = content.replace(/^!ingat\s*/i, '').trim();
  if (!teks) {
    await message.reply('Formatnya: `!ingat <isi info yang mau disimpan>`');
    return;
  }

  const memoryData = loadMemoryData();
  memoryData.push({
    teks,
    disimpanOleh: message.author.tag,
    userId: message.author.id,
    waktu: new Date().toISOString(),
  });

  const ok = saveMemoryData(memoryData);
  if (ok) {
    await message.reply(`Oke, aku simpan ya! ${EMOJI.cheerful} (total ${memoryData.length} memori tersimpan)`);
  } else {
    await message.reply(`Duh, gagal simpan memorinya, coba lagi ya ${EMOJI.confused}`);
  }
}

// ====== COMMAND MEMORY: !lupain <nomor> ======
async function handleForgetCommand(message, args) {
  if (!isAllowedToManageMemory(message)) {
    await message.reply('Command ini cuma buat orang tertentu yaa 🙏');
    return;
  }

  const memoryData = loadMemoryData();
  const index = parseInt(args[1], 10);

  if (!index || index < 1 || index > memoryData.length) {
    await message.reply(`Nomor gak valid. Ketik \`!listmemori\` dulu buat liat nomornya (total ${memoryData.length} memori).`);
    return;
  }

  const removed = memoryData.splice(index - 1, 1)[0];
  saveMemoryData(memoryData);
  await message.reply(`Oke, memori ke-${index} udah dihapus: "${removed.teks}"`);
}

// ====== COMMAND MEMORY: !listmemori ======
async function handleListMemoryCommand(message) {
  if (!isAllowedToManageMemory(message)) {
    await message.reply('Command ini cuma buat orang tertentu yaa 🙏');
    return;
  }

  const memoryData = loadMemoryData();
  if (memoryData.length === 0) {
    await message.reply('Belum ada memori yang tersimpan.');
    return;
  }

  const listText = memoryData
    .map((m, i) => `${i + 1}. ${m.teks} (oleh ${m.disimpanOleh})`)
    .join('\n');
  // Discord batas 2000 karakter per pesan, potong kalau kepanjangan
  const truncated = listText.length > 1900 ? `${listText.slice(0, 1900)}\n...(terpotong)` : listText;
  await message.reply(`**Daftar memori tersimpan:**\n${truncated}`);
}

// ====== ACCESS REMINDER: !kasihakses @user <1|2> (khusus Administrator) ======
// Nyatet user ke daftar internal, nanti bot DM otomatis sekali di hari Minggu jam 08.00 WIB
// terdekat. GAK ngubah permission Discord apapun — cuma catatan + DM pengingat.

function loadAccessData() {
  try {
    if (!fs.existsSync(ACCESS_DATA_PATH)) return [];
    const raw = fs.readFileSync(ACCESS_DATA_PATH, 'utf-8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error('Gagal load access-schedule.json:', err);
    return [];
  }
}

function saveAccessData(data) {
  try {
    fs.writeFileSync(ACCESS_DATA_PATH, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('Gagal simpan access-schedule.json:', err);
    return false;
  }
}

async function handleGiveAccessCommand(message, content) {
  if (!isAdministrator(message)) {
    await message.reply('Command ini cuma buat Administrator yaa 🙏');
    return;
  }

  const targetUser = message.mentions.users?.first();
  const serverMatch = content.match(/\b([12])\b(?!.*\b[12]\b)/); // ambil angka 1/2 TERAKHIR di pesan (biar gak ketuker sama angka di mention)

  if (!targetUser || !serverMatch) {
    await message.reply(`Format: \`!dm @user <1 atau 2>\` — contoh: \`!dm @Budi 1\` ${EMOJI.pmksd}`);
    return;
  }

  const server = serverMatch[1];
  const accessData = loadAccessData();
  accessData.push({
    userId: targetUser.id,
    username: targetUser.tag,
    server,
    notified: false,
    grantedAt: new Date().toISOString(),
    grantedBy: message.author.tag,
  });
  saveAccessData(accessData);

  await message.reply(`✅ Oke, ${targetUser.tag} udah dicatet — bakal di-DM reminder Server ${server} ${describeDmSchedule()} terdekat. ${EMOJI.ketjeh}`);
}

function getWIBParts(date) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const parts = formatter.formatToParts(date);
  const map = {};
  parts.forEach((p) => {
    map[p.type] = p.value;
  });
  return map;
}

// ====== GENERAL REMINDER: !reminder sekali/harian (khusus Administrator) ======

function loadReminders() {
  try {
    if (!fs.existsSync(REMINDER_DATA_PATH)) return [];
    const raw = fs.readFileSync(REMINDER_DATA_PATH, 'utf-8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error('Gagal load reminders.json:', err);
    return [];
  }
}

function saveReminders(data) {
  try {
    fs.writeFileSync(REMINDER_DATA_PATH, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('Gagal simpan reminders.json:', err);
    return false;
  }
}

async function handleReminderCommand(message, content) {
  if (!isAdministrator(message)) {
    await message.reply(`Command ini cuma buat Administrator yaa ${EMOJI.pmksd}`);
    return;
  }

  // !reminder sekali DD-MM-YYYY HH:MM <pesan>
  const onceMatch = content.match(/^!reminder\s+sekali\s+(\d{1,2})-(\d{1,2})-(\d{4})\s+(\d{1,2})[:.](\d{2})\s+([\s\S]+)$/i);
  // !reminder harian HH:MM <pesan>
  const dailyMatch = content.match(/^!reminder\s+harian\s+(\d{1,2})[:.](\d{2})\s+([\s\S]+)$/i);

  if (onceMatch) {
    const [, day, month, year, hour, minute, pesan] = onceMatch;
    const dateKey = `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    const timeKey = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;

    const reminders = loadReminders();
    reminders.push({
      id: Date.now().toString(36),
      type: 'once',
      dateKey,
      time: timeKey,
      message: pesan.trim(),
      channelId: message.channel.id,
      createdBy: message.author.tag,
      notified: false,
    });
    saveReminders(reminders);

    await message.reply(`✅ Oke, reminder sekali diset buat ${day}-${month}-${year} jam ${timeKey} WIB di channel ini. ${EMOJI.ketjeh}`);
    return;
  }

  if (dailyMatch) {
    const [, hour, minute, pesan] = dailyMatch;
    const timeKey = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;

    const reminders = loadReminders();
    reminders.push({
      id: Date.now().toString(36),
      type: 'daily',
      time: timeKey,
      message: pesan.trim(),
      channelId: message.channel.id,
      createdBy: message.author.tag,
      lastFiredDateKey: null,
    });
    saveReminders(reminders);

    await message.reply(`✅ Oke, reminder harian diset tiap jam ${timeKey} WIB di channel ini. ${EMOJI.ketjeh}`);
    return;
  }

  await message.reply(
    `Format:\n\`!reminder sekali DD-MM-YYYY HH:MM <pesan>\`\n\`!reminder harian HH:MM <pesan>\`\nContoh: \`!reminder harian 07:30 Selamat pagi, cek slot yuk!\` ${EMOJI.pmksd}`
  );
}

async function handleReminderListCommand(message) {
  if (!isAdministrator(message)) {
    await message.reply(`Command ini cuma buat Administrator yaa ${EMOJI.pmksd}`);
    return;
  }

  const reminders = loadReminders();
  if (reminders.length === 0) {
    await message.reply('Belum ada reminder yang diset.');
    return;
  }

  const listText = reminders
    .map((r, i) => {
      if (r.type === 'once') {
        const status = r.notified ? ' (udah kekirim ✅)' : '';
        return `${i + 1}. [SEKALI] ${r.dateKey} ${r.time} WIB — "${r.message}" di <#${r.channelId}>${status}`;
      }
      return `${i + 1}. [HARIAN] tiap jam ${r.time} WIB — "${r.message}" di <#${r.channelId}>`;
    })
    .join('\n');

  const truncated = listText.length > 1900 ? `${listText.slice(0, 1900)}\n...(terpotong)` : listText;
  await message.reply(`**Daftar reminder:**\n${truncated}`);
}

async function handleReminderDeleteCommand(message, args) {
  if (!isAdministrator(message)) {
    await message.reply(`Command ini cuma buat Administrator yaa ${EMOJI.pmksd}`);
    return;
  }

  const reminders = loadReminders();
  const index = parseInt(args[1], 10);

  if (!index || index < 1 || index > reminders.length) {
    await message.reply(`Nomor gak valid. Ketik \`!reminderlist\` dulu buat liat nomornya (total ${reminders.length}).`);
    return;
  }

  const removed = reminders.splice(index - 1, 1)[0];
  saveReminders(reminders);
  await message.reply(`✅ Reminder ke-${index} dihapus: "${removed.message}"`);
}

async function sendReminderMessage(client, r) {
  try {
    const channel = await client.channels.fetch(r.channelId);
    await channel.send(`${EMOJI.excited} **Reminder:** ${r.message}`);
  } catch (err) {
    console.error(`Gagal kirim reminder "${r.message}":`, err.message || err);
  }
}

async function checkAndSendGeneralReminders(client) {
  const parts = getWIBParts(new Date());
  const currentTime = `${parts.hour}:${parts.minute}`;
  const currentDateKey = `${parts.year}-${parts.month}-${parts.day}`;

  const reminders = loadReminders();
  let changed = false;

  for (const r of reminders) {
    if (r.time !== currentTime) continue;

    if (r.type === 'once') {
      if (r.notified || r.dateKey !== currentDateKey) continue;
      await sendReminderMessage(client, r);
      r.notified = true;
      changed = true;
    } else if (r.type === 'daily') {
      if (r.lastFiredDateKey === currentDateKey) continue;
      await sendReminderMessage(client, r);
      r.lastFiredDateKey = currentDateKey;
      changed = true;
    }
  }

  if (changed) saveReminders(reminders);
}

async function checkAndSendAccessReminders(client) {
  const parts = getWIBParts(new Date());
  const sched = getDmSchedule(); // bisa diubah lewat !dmjam
  const nowMin = (parseInt(parts.hour, 10) % 24) * 60 + parseInt(parts.minute, 10);
  const targetMin = sched.hour * 60 + sched.minute;
  if (parts.weekday !== sched.weekday || nowMin < targetMin || nowMin >= targetMin + 60) return;

  const dateKey = `${parts.year}-${parts.month}-${parts.day}`;
  if (lastAccessReminderDateKey === dateKey) return; // udah pernah jalan hari ini
  lastAccessReminderDateKey = dateKey;

  const accessData = loadAccessData();
  const pending = accessData.filter((a) => !a.notified);
  if (pending.length === 0) return;

  console.log(`[AccessReminder] Ngirim DM ke ${pending.length} user (${describeDmSchedule()})...`);

  for (const entry of pending) {
    const channelId = entry.server === '2' ? AUTOLIST_CHANNEL_IDS[1] : AUTOLIST_CHANNEL_IDS[0];
    const channelMention = channelId ? `<#${channelId}>` : 'channel autolist';
    const reminderText = `${EMOJI.loplop} Halo ${entry.username}! Ini reminder buat slot PTPT Server ${entry.server} kamu — langsung cek listnya di ${channelMention} yaa. Semoga hoki hari ini! ${EMOJI.ha}`;

    try {
      const user = await client.users.fetch(entry.userId);
      await user.send(reminderText);
      entry.notified = true;
    } catch (err) {
      // DM gagal — biasanya karena user matiin "Allow DMs from server members"
      // (privacy setting Discord, cuma bisa diubah user itu sendiri, bot gak bisa maksa).
      // Fallback: post reminder-nya di channel biasa, tag user-nya langsung, biar tetap kelihatan.
      console.error(`[AccessReminder] Gagal DM ke ${entry.username} (kemungkinan DM ditutup):`, err.message || err);
      try {
        if (channelId) {
          const fallbackChannel = await client.channels.fetch(channelId);
          await fallbackChannel.send(`<@${entry.userId}> ${reminderText}\n_(DM ke kamu gagal — mungkin "Allow DMs from server members" lagi mati, jadi reminder ini dikirim di sini yaa)_`);
        }
        entry.notified = true;
      } catch (fallbackErr) {
        console.error(`[AccessReminder] Fallback channel juga gagal buat ${entry.username}:`, fallbackErr.message || fallbackErr);
        // notified TETAP false — biar dicoba lagi Minggu depan, bukan hilang gitu aja.
      }
    }
  }

  saveAccessData(accessData);
}

// ====== UTIL: PARSE DURASI (10s, 10m, 10h, 10d) ======
function parseDuration(input) {
  const match = (input || '').trim().match(/^(\d+)\s*(s|m|h|d)$/i);
  if (!match) return null;

  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const multiplier = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };

  return value * multiplier[unit];
}

// ====== UTIL: CEK ADMINISTRATOR ======
function isAdministrator(message) {
  return message.member?.permissions?.has(PermissionsBitField.Flags.Administrator) ?? false;
}

// ====== COMMAND MODERASI: !timeout @user 10m [alasan] ======
async function handleTimeoutCommand(message, args) {
  if (!isAdministrator(message)) {
    await message.reply('Command ini cuma buat Administrator yaa 🙏');
    return;
  }

  const targetMember = message.mentions.members?.first();
  if (!targetMember) {
    await message.reply(`Format: \`!timeout @user 10m [alasan]\` — mention usernya yaa. ${EMOJI.pmksd}`);
    return;
  }

  // args[0] biasanya mention, args[1] durasi, sisanya alasan
  const durationArg = args[1];
  const durationMs = parseDuration(durationArg);
  if (!durationMs) {
    await message.reply('Format durasi salah. Contoh yang benar: `10s`, `10m`, `1h`, `1d`.');
    return;
  }

  const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000; // batas Discord: 28 hari
  if (durationMs > MAX_TIMEOUT_MS) {
    await message.reply('Durasi timeout maksimal Discord itu 28 hari yaa.');
    return;
  }

  const reason = args.slice(2).join(' ') || `Timeout oleh ${message.author.tag}`;

  try {
    await targetMember.timeout(durationMs, reason);
    await message.reply(`✅ ${targetMember.user.tag} kena timeout selama ${durationArg}. Alasan: ${reason} ${EMOJI.ngamuk}`);
  } catch (err) {
    console.error('Gagal timeout member:', err);
    await message.reply('Gagal timeout usernya, cek permission bot (perlu izin "Timeout Members").');
  }
}

// ====== COMMAND MODERASI: !removerole @user @role ======
async function handleRemoveRoleCommand(message) {
  if (!isAdministrator(message)) {
    await message.reply('Command ini cuma buat Administrator yaa 🙏');
    return;
  }

  const targetMember = message.mentions.members?.first();
  const targetRole = message.mentions.roles?.first();

  if (!targetMember || !targetRole) {
    await message.reply(`Format: \`!removerole @user @role\` — mention usernya sama role-nya yaa. ${EMOJI.pmksd}`);
    return;
  }

  try {
    await targetMember.roles.remove(targetRole, `Role dicopot oleh ${message.author.tag}`);
    await message.reply(`✅ Role ${targetRole.name} berhasil dicopot dari ${targetMember.user.tag}. ${EMOJI.ketjeh}`);
  } catch (err) {
    console.error('Gagal copot role:', err);
    await message.reply('Gagal copot role-nya, cek permission bot (perlu izin "Manage Roles", dan posisi role bot harus di atas role yang mau dicopot).');
  }
}

// ====== COMMAND MODERASI: !addrole @user @role ======
async function handleAddRoleCommand(message) {
  if (!isAdministrator(message)) {
    await message.reply('Command ini cuma buat Administrator yaa 🙏');
    return;
  }

  const targetMember = message.mentions.members?.first();
  const targetRole = message.mentions.roles?.first();

  if (!targetMember || !targetRole) {
    await message.reply(`Format: \`!addrole @user @role\` — mention usernya sama role-nya yaa. ${EMOJI.pmksd}`);
    return;
  }

  try {
    await targetMember.roles.add(targetRole, `Role ditambahkan oleh ${message.author.tag}`);
    await message.reply(`✅ Role ${targetRole.name} berhasil ditambahkan ke ${targetMember.user.tag}. ${EMOJI.ketjeh}`);
  } catch (err) {
    console.error('Gagal tambah role:', err);
    await message.reply('Gagal nambahin role-nya, cek permission bot (perlu izin "Manage Roles", dan posisi role bot harus di atas role yang mau ditambahkan).');
  }
}

// ====== AUTO-CONGRATS SAAT ADA YANG DAPET FORGOTTEN ======
const FORGOTTEN_CONGRATS_VARIANTS = [
  'CONGRATS {mention}!! 🔥😭 Forgotten Naik juga akhirnya!',
  'WOOO {mention} DAPET FORGOTTEN?? 🔥 selamat yaa, screenshot jangan lupa!',
  'GG {mention}  forgotten berhasil di angkat, GOKIL!',
  '{mention} FORGOTTEN Njir 😭 selamat,Gak emosi doang yang ngangkat!',
  'anjay {mention} dapet forgotten 😭🔥 congrats yaa, forgotten keberapa nih?!',
];

function extractMention(embed) {
  const parts = [
    embed.title || '',
    embed.description || '',
    ...(embed.fields || []).map((f) => `${f.name} ${f.value}`),
  ];
  const combined = parts.join(' ');
  const match = combined.match(/<@!?(\d+)>/);
  return match ? match[0] : null;
}

// ====== PLAYER MONITOR: baca embed "Check Player On Server" dari BLOX Gank ======

function parseCheckPlayerEmbed(embed) {
  const title = embed.title || '';
  const titleMatch = title.match(/Check Player On Server\s+(\S+)/i);
  const anchorPlayer = titleMatch ? titleMatch[1] : null;

  // Kumpulin semua teks yang mungkin berisi list player — description atau fields,
  // tergantung gimana BLOX Gank nyusun embed-nya.
  const textBlocks = [embed.description || '', ...(embed.fields || []).map((f) => `${f.name}\n${f.value}`)];
  const fullText = textBlocks.join('\n');

  // Pola per baris: • username - Caught: 3.1M - <emoji apapun/opsional> Lokasi (est.)
  // Username BOLEH dibungkus ** atau enggak. Lokasi diambil apa adanya dulu, baru
  // dibersihin dari emoji/tag di depannya pas post-processing di bawah.
  const lineRegex = /[•\-]\s*\*{0,2}(\S+?)\*{0,2}\s+-\s*Caught:\s*([\d.,]+[A-Za-z]*)\s*-\s*(.+?)\s*(?:\n|$)/gim;
  const players = [];
  let match;
  while ((match = lineRegex.exec(fullText)) !== null) {
    const username = match[1].trim();
    const caught = match[2].trim();

    let location = match[3].trim();
    location = location.replace(/\(est\.\)\s*$/i, '').trim();
    // Buang custom emoji Discord (format <:nama:id> atau <a:nama:id>) di depan lokasi
    location = location.replace(/^(<a?:\w+:\d+>\s*)+/i, '').trim();
    // Buang sisa karakter non-huruf/angka di depan (emoji unicode, simbol, dll)
    location = location.replace(/^[^\p{L}\p{N}]+/u, '').trim();
    if (!location) location = 'N/A';

    players.push({ username, caught, location });
  }

  const luckMatch = fullText.match(/Server Luck\*{0,2}\s*:\s*([^\n]+)/i);
  const serverLuck = luckMatch ? luckMatch[1].trim() : null;

  return { anchorPlayer, players, serverLuck };
}

function updatePlayerLocationData(parsed) {
  const now = Date.now();
  for (const p of parsed.players) {
    playerLocationData.set(p.username.toLowerCase(), {
      username: p.username,
      location: p.location,
      caught: p.caught,
      anchorServer: parsed.anchorPlayer,
      serverLuck: parsed.serverLuck,
      updatedAt: now,
    });
  }
}

async function handlePossibleCheckPlayerEmbed(message) {
  if (PLAYER_MONITOR_CHANNEL_IDS.length === 0) return;
  if (!PLAYER_MONITOR_CHANNEL_IDS.includes(message.channel.id)) return;

  // DEBUG: log tiap pesan yang masuk di channel yang di-monitor, biar ketauan
  // apakah bot beneran "denger" pesannya atau enggak sama sekali.
  console.log(`[PlayerMonitor][DEBUG] Pesan masuk di channel monitor dari ${message.author.tag} (bot: ${message.author.bot}), jumlah embed: ${message.embeds?.length || 0}`);

  if (!message.embeds || message.embeds.length === 0) return;

  for (const embed of message.embeds) {
    console.log(`[PlayerMonitor][DEBUG] Embed title: "${embed.title || '(kosong)'}"`);
    if (!embed.title || !/Check Player On Server/i.test(embed.title)) continue;
    const parsed = parseCheckPlayerEmbed(embed);
    if (parsed.players.length > 0) {
      updatePlayerLocationData(parsed);
      console.log(`[PlayerMonitor] Update ${parsed.players.length} player (server ${parsed.anchorPlayer || '?'})`);
    } else {
      console.log('[PlayerMonitor][DEBUG] Title cocok tapi 0 player ke-parse — kemungkinan format beda dari yang diduga.');
      console.log('[PlayerMonitor][DEBUG] RAW description:', JSON.stringify(embed.description || '(kosong)'));
      console.log('[PlayerMonitor][DEBUG] RAW fields:', JSON.stringify(embed.fields || []));
    }
  }
}

function formatElapsed(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'baru aja';
  if (minutes < 60) return `${minutes} menit lalu`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} jam lalu`;
  const days = Math.floor(hours / 24);
  return `${days} hari lalu`;
}

// Cek apakah pertanyaan user itu nanya lokasi player yang datanya kita punya.
// Return string jawaban siap-pakai kalau ketemu, null kalau gak relevan/gak ketemu.
function findPlayerLocationAnswer(question) {
  if (playerLocationData.size === 0) return null;

  const asksLocation = /(di\s?mana|dimana|lokasi|posisi|server apa|ada di server)/i.test(question);
  if (!asksLocation) return null;

  const lower = question.toLowerCase();
  for (const [usernameLower, data] of playerLocationData) {
    const escaped = usernameLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\b${escaped}\\b`, 'i');
    if (!pattern.test(lower)) continue;

    const elapsed = formatElapsed(Date.now() - data.updatedAt);
    return `${data.username} terakhir kelihatan di 📍 ${data.location} (Caught: ${data.caught}), satu server sama ${data.anchorServer}. Update terakhir: ${elapsed}.`;
  }

  return null;
}

// ====== DELETE LOG: log isi pesan yang dihapus ke channel tertentu ======
// Catatan: ini CUMA bisa nangkep pesan yang bot sempat "lihat" sebelum dihapus (via cache
// Discord.js). Pesan yang dihapus sebelum bot pernah proses pesan itu (misal bot baru
// restart) gak bisa di-recover — ini batasan dari Discord API sendiri, bukan kode.
async function logDeletedMessage(client, message) {
  console.log(`[DeleteLog][DEBUG] Event messageDelete ke-trigger. Channel: ${message.channel?.id}, partial: ${message.partial}, author: ${message.author?.tag || '(gak diketahui/partial)'}`);

  if (DELETE_LOG_CHANNEL_IDS.length === 0) {
    console.log('[DeleteLog][DEBUG] DELETE_LOG_CHANNEL_ID kosong, fitur nonaktif.');
    return;
  }
  if (isBotSilenced) {
    console.log('[DeleteLog][DEBUG] Bot lagi mode diam, skip log.');
    return;
  }
  if (message.author?.id === client.user?.id) {
    console.log('[DeleteLog][DEBUG] Ini pesan Bloxy sendiri, skip log.');
    return;
  }

  const logChannelId = DELETE_LOG_CHANNEL_IDS[0];

  try {
    const logChannel = await client.channels.fetch(logChannelId);

    const isUnknown = message.partial || message.content === null || message.content === undefined;
    const contentText = isUnknown
      ? '_(isi pesan gak kebaca — pesan ini belum sempat ke-cache bot sebelum dihapus)_'
      : message.content || '_(pesan kosong — mungkin cuma gambar/attachment)_';

    const authorText = message.author ? `${message.author.tag} (${message.author.id})` : 'Gak diketahui';

    const lines = [
      `🗑️ **Pesan dihapus** di <#${message.channel?.id || 'channel tidak diketahui'}>`,
      `Author: ${authorText}`,
      `Konten: ${contentText}`,
    ];

    if (message.attachments && message.attachments.size > 0) {
      const urls = Array.from(message.attachments.values())
        .map((a) => a.url)
        .join('\n');
      lines.push(`Lampiran:\n${urls}`);
    }

    await logChannel.send(lines.join('\n'));
    console.log('[DeleteLog][DEBUG] Berhasil kirim log pesan terhapus.');
  } catch (err) {
    console.error('[DeleteLog][DEBUG] GAGAL log pesan terhapus:', err.message || err);
  }
}

async function logBulkDeletedMessages(client, messages) {
  if (DELETE_LOG_CHANNEL_IDS.length === 0) return;
  if (isBotSilenced) return;

  const logChannelId = DELETE_LOG_CHANNEL_IDS[0];

  try {
    const logChannel = await client.channels.fetch(logChannelId);
    const firstMsg = messages.first();
    const channelMention = firstMsg?.channel ? `<#${firstMsg.channel.id}>` : 'sebuah channel';
    await logChannel.send(`🗑️ **${messages.size} pesan dihapus sekaligus** (bulk delete) di ${channelMention}`);
  } catch (err) {
    console.error('Gagal log bulk delete:', err);
  }
}

async function handlePossibleForgottenNotification(message) {
  if (FORGOTTEN_WATCH_CHANNEL_IDS.length === 0) return;
  if (!FORGOTTEN_WATCH_CHANNEL_IDS.includes(message.channel.id)) return;
  if (message.embeds.length === 0) return;

  for (const embed of message.embeds) {
    const title = (embed.title || '').trim().toLowerCase();

    // Pakai partial match (bukan exact match) biar tetap kena walau ada emoji/teks
    // tambahan di title, misal "🔴 Forgotten Tier Detected!".
    if (!title.includes(FORGOTTEN_TITLE)) continue;

    // Mention Discord-nya ternyata ada di TEKS PESAN (di atas embed), bukan di dalam
    // embed itu sendiri — makanya cek message.mentions dulu (paling akurat, langsung
    // dari Discord API), baru fallback ke scan teks embed kalau-kalau ada juga di situ.
    let mention = null;
    const firstMentionedUser = message.mentions.users?.first();
    if (firstMentionedUser) {
      mention = `<@${firstMentionedUser.id}>`;
    } else {
      mention = extractMention(embed);
    }

    if (!mention) {
      console.log('[DEBUG forgotten-watch] Title cocok tapi gak nemu mention Discord sama sekali (baik di teks pesan maupun di embed).');
      continue;
    }

    const variant = FORGOTTEN_CONGRATS_VARIANTS[Math.floor(Math.random() * FORGOTTEN_CONGRATS_VARIANTS.length)];
    const congratsText = variant.replace('{mention}', mention);

    try {
      await message.channel.send(congratsText);
    } catch (err) {
      console.error('Gagal kirim ucapan selamat forgotten:', err);
    }

    break; // cukup satu ucapan per pesan, walau ada beberapa embed
  }
}

// ====== DISCORD CLIENT ======
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel, Partials.Message],
});

require('./verify')(client); // verifikasi member baru lewat tombol (!verifikasi)
require('./anon-qa')(client); // tanya jawab anonim (!anonim)
require('./poll')(client); // voting pakai tombol (!poll)
require('./disconnect-alert')(client); // peringatan kalau banyak pemain disconnect serempak

client.once('ready', () => {
  isBotSilenced = loadSilenceState();
  console.log(`Bot login sebagai ${client.user.tag}`);
  console.log(`Mendengarkan channel: ${ALLOWED_CHANNEL_IDS.join(', ') || '(semua channel — belum di-set)'}`);
  console.log(`Mode diam: ${isBotSilenced ? 'AKTIF (bot lagi diem)' : 'nonaktif'}`);
  console.log(`Player Monitor channel: ${PLAYER_MONITOR_CHANNEL_IDS.join(', ') || '(KOSONG — fitur ini nonaktif!)'}`);
  console.log(`Auto-React channel: ${AUTOREACT_CHANNEL_IDS.join(', ') || '(KOSONG — fitur ini nonaktif!)'}`);
  console.log(`Auto-React emoji: ${AUTOREACT_EMOJIS.join(', ')}`);
  console.log(`Delete Log channel: ${DELETE_LOG_CHANNEL_IDS.join(', ') || '(KOSONG — fitur ini nonaktif!)'}`);

  // Cek tiap 1 menit apakah sekarang Minggu jam 08.00 WIB, buat kirim access reminder.
  setInterval(() => {
    checkAndSendAccessReminders(client).catch((err) => console.error('Error cek access reminder:', err));
    checkAndSendGeneralReminders(client).catch((err) => console.error('Error cek general reminder:', err));
  }, 60 * 1000);
});

client.on('messageCreate', async (message) => {
  // Honeypot: paling awal, supaya pesan jebakan gak sempat diproses fitur lain (auto-react, FAQ, dll.).
  try {
    if (await handleHoneypotMessage(message)) return;
  } catch (err) {
    console.error('Error saat cek honeypot:', err);
  }

  // 1. Cek notif "Forgotten Tier Detected!" dari bot lain (blox-gank-bot) — ini HARUS
  //    jalan duluan dan gak boleh ke-block sama pengecekan "abaikan pesan dari bot" di bawah,
  //    soalnya notifnya justru datang dari bot lain.
  //    Tapi tetap di-skip kalau mode diam aktif, biar bener-bener gak nyaut apapun.
  // Player monitor selalu jalan (capture data doang, gak ngirim pesan apapun) — gak
  // perlu di-skip walau bot lagi mode diam, karena ini bukan "bicara".
  try {
    await handlePossibleCheckPlayerEmbed(message);
  } catch (err) {
    console.error('Error saat cek embed check player:', err);
  }

  if (!isBotSilenced) {
    try {
      await handlePossibleForgottenNotification(message);
    } catch (err) {
      console.error('Error saat cek notif forgotten:', err);
    }
    try {
      await handlePossibleAutolistUpdate(client, message);
    } catch (err) {
      console.error('Error saat cek update autolist:', err);
    }
  }

  // Auto-react & Auto-translate — dicek SEBELUM filter "abaikan bot" di bawah, soalnya
  // keduanya perlu bisa proses pesan dari webhook juga (yang punya author.bot=true tapi
  // bukan bot Discord beneran). Masing-masing fungsi udah ada pengecekan sendiri buat
  // bedain bot asli vs webhook.
  if (!isBotSilenced) {
    try {
      await handleAutoReact(message);
    } catch (err) {
      console.error('Error saat auto-react:', err);
    }
    try {
      await handlePossibleTranslate(client, message);
    } catch (err) {
      console.error('Error saat auto-translate:', err);
    }
  }

  // Abaikan pesan dari bot untuk semua logic di bawah ini (FAQ & command moderasi)
  if (message.author.bot) return;

  // 2. Command moderasi (admin-only) — dicek sebelum logic FAQ biasa
  const content = message.content.trim();

  // !diam / !kembali bicara HARUS tetap bisa dipanggil walaupun bot lagi mode diam,
  // makanya dicek paling duluan, sebelum pengecekan isBotSilenced di bawah.
  if (content === '!diam') {
    await handleSilenceCommand(message, true);
    return;
  }
  if (content === '!kembali bicara') {
    await handleSilenceCommand(message, false);
    return;
  }

  // Kalau bot lagi mode diam, stop di sini — gak proses command lain, FAQ, ataupun AI.
  if (isBotSilenced) return;

  // Auto-moderation dicek duluan untuk SEMUA pesan (kecuali admin) sebelum command/FAQ diproses.
  if (await checkAutoMod(message)) return;

  // Pendaftaran war boss: member ketik "ikut" / "batal" di channel yang war-nya lagi kebuka.
  if (await handleWarJoin(message)) return;

  // Semua command di bawah ini dibungkus try/catch — biar kalau ada error internal,
  // GAK diem doang (susah di-debug), tapi ke-log jelas + bot kasih tau di chat.
  try {
    if (await handleRoleToolsCommand(message, content)) return;
    if (await handleExtraCommand(message, content)) return;
    if (content.startsWith('!hapus ') || content === '!hapus') {
      await handlePurgeCommand(message, content);
      return;
    }
    if (content.startsWith('!umumin ') || content === '!umumin') {
      await handleAnnounceCommand(message, content);
      return;
    }
    if (content.startsWith('!dm ') || content === '!dm') {
      await handleGiveAccessCommand(message, content);
      return;
    }
    if (content.startsWith('!reminder ') || content === '!reminder') {
      await handleReminderCommand(message, content);
      return;
    }
    if (content === '!reminderlist') {
      await handleReminderListCommand(message);
      return;
    }
    if (content.startsWith('!reminderhapus ') || content === '!reminderhapus') {
      const args = content.split(/\s+/);
      await handleReminderDeleteCommand(message, args);
      return;
    }
    if (content.startsWith('!timeout ') || content === '!timeout') {
      const args = content.split(/\s+/);
      await handleTimeoutCommand(message, args);
      return;
    }
    if (content.startsWith('!removerole ') || content === '!removerole') {
      await handleRemoveRoleCommand(message);
      return;
    }
    if (content.startsWith('!addrole ') || content === '!addrole') {
      await handleAddRoleCommand(message);
      return;
    }
    if (content.startsWith('!ingat ') || content === '!ingat') {
      await handleRememberCommand(message, content);
      return;
    }
    if (content.startsWith('!lupain ') || content === '!lupain') {
      const args = content.split(/\s+/);
      await handleForgetCommand(message, args);
      return;
    }
    if (content === '!listmemori') {
      await handleListMemoryCommand(message);
      return;
    }
  } catch (err) {
    console.error(`[Command Error] Gagal proses command "${content}":`, err);
    await message.reply('Duh, ada error internal pas proses command ini. Cek log console bot yaa 🙏').catch(() => {});
    return;
  }

  // 3. FAQ biasa — hanya di channel yang diizinkan (kalau sudah di-set)
  if (ALLOWED_CHANNEL_IDS.length > 0 && !ALLOWED_CHANNEL_IDS.includes(message.channel.id)) {
    return;
  }

  const question = message.content.trim();
  if (!question) return;

  try {
    const faqData = loadFaqData();
    const matched = findAnswer(faqData, question);

    // Kalau user ini masih kena cooldown, bot diam saja (gak spam balasan) —
    // dicek di awal biar berlaku baik untuk jawaban keyword maupun AI fallback.
    if (isOnCooldown(message.author.id)) {
      if (message.mentions.has(client.user.id)) message.react('⏳').catch(() => {});
      return;
    }

    let replyText = null;
    let isFailReply = false;

    if (matched) {
      // Ada keyword yang cocok → pakai jawaban FAQ (cepat & pasti akurat).
      if (matched.dynamic === 'slot_status') {
        replyText = await getSlotStatusReply(client);
      } else {
        replyText = pickAnswer(matched.jawaban);
      }
    } else if (AI_FALLBACK_ENABLED) {
      // Cek apakah pesan ini memang ditujukan ke bot: di-mention, reply ke pesan bot,
      // atau nyebut nama panggilannya (misal "bloxy").
      const isMentioned = message.mentions.has(client.user.id);
      const isReplyToBot = message.reference?.messageId
        ? (await message.channel.messages.fetch(message.reference.messageId).catch(() => null))?.author?.id === client.user.id
        : false;
      const normalizedQuestion = question.toLowerCase();
      const isCalledByName = BOT_NICKNAMES.some((name) => {
        // Cek sebagai "kata utuh" biar gak ke-trigger sama kebetulan substring
        // (misal nama "bloxy" gak nge-trigger gara-gara kata "bloxyz" atau semacamnya).
        const pattern = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        return pattern.test(normalizedQuestion);
      });
      const isDirectedToBot = isMentioned || isReplyToBot || isCalledByName;

      if (!AI_REQUIRE_MENTION || isDirectedToBot) {
        // Buang bagian mention (misal "@BotName") dari teks sebelum dikirim ke AI.
        const cleanedQuestion = question.replace(/<@!?\d+>/g, '').trim();
        if (cleanedQuestion) {
          // Cek dulu apakah ini nanya lokasi player yang datanya kita punya (dari
          // Player Monitor) — kalau ketemu, jawab langsung dari data, gak usah ke AI
          // (lebih cepat & gak beresiko salah/ngarang).
          const playerAnswer = findPlayerLocationAnswer(cleanedQuestion);
          if (playerAnswer) {
            replyText = playerAnswer;
          } else {
            const memoryData = loadMemoryData();
            await message.channel.sendTyping().catch(() => {});
            replyText = await askGroqAI(faqData, memoryData, cleanedQuestion);
            // Bot jelas lagi dipanggil tapi AI gagal → jangan diam, kasih tahu.
            if (!replyText && isDirectedToBot) {
              replyText = AI_FAIL_REPLY;
              isFailReply = true;
            }
          }
        }
      }
    }

    // Kalau tetap gak ada jawaban (baik dari FAQ maupun AI gagal/nonaktif), bot diam saja.
    if (!replyText) return;

    if (replyText.length > 1990) replyText = `${replyText.slice(0, 1987)}...`; // batas pesan Discord 2000 karakter
    await message.reply(replyText);
    if (!isFailReply) markReplied(message.author.id); // balasan gagal gak bikin kena cooldown, jadi bisa langsung coba lagi
  } catch (err) {
    console.error('Error saat memproses pertanyaan:', err);
  }
});

client.on('messageDelete', async (message) => {
  try {
    await logDeletedMessage(client, message);
  } catch (err) {
    console.error('Error saat log pesan terhapus:', err);
  }
});

client.on('messageDeleteBulk', async (messages) => {
  try {
    await logBulkDeletedMessages(client, messages);
  } catch (err) {
    console.error('Error saat log bulk delete:', err);
  }
});

client.on('messageUpdate', async (oldMessage, newMessage) => {
  // Embed "LIST PTPT AKTIF" biasanya di-EDIT di tempat (pinned message yang di-update terus),
  // bukan post pesan baru tiap kali slot berubah — makanya perlu dengerin event edit ini juga.
  if (isBotSilenced) return;
  try {
    // newMessage kadang partial (belum full-fetch) — fetch dulu biar embeds-nya lengkap.
    const fullMessage = newMessage.partial ? await newMessage.fetch().catch(() => null) : newMessage;
    if (!fullMessage) return;
    await handlePossibleAutolistUpdate(client, fullMessage);
  } catch (err) {
    console.error('Error saat cek update autolist (messageUpdate):', err);
  }
});

client.login(DISCORD_TOKEN);