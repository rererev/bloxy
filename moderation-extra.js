// moderation-extra.js — tambahan moderasi untuk Bloxy:
//   1. !hapus <jumlah>      → hapus N pesan terakhir di channel (1–100)
//   2. containsSexualContent → deteksi pesan berbau seksual untuk auto-delete
//
// ENV opsional:
//   AUTOMOD_SEXUAL_ENABLED=false   → matikan filter seksual
//   AUTOMOD_SEXUAL_WORDS=kata1,kata2 → tambah kata sendiri ke daftar bawaan
//   AUTOMOD_SEXUAL_ALLOW=kata1,kata2 → kata yang dikecualikan dari daftar bawaan

const { PermissionsBitField } = require('discord.js');

// ====== 1. !hapus <jumlah> ======

const MAX_PURGE = 100; // batas bulkDelete Discord per panggilan

function canPurge(message) {
  const perms = message.member?.permissions;
  return (
    perms?.has(PermissionsBitField.Flags.Administrator) ||
    perms?.has(PermissionsBitField.Flags.ManageMessages) ||
    false
  );
}

async function replyTemp(message, text, ms = 6000) {
  const sent = await message.channel.send(text).catch(() => null);
  if (sent) setTimeout(() => sent.delete().catch(() => {}), ms);
}

async function handlePurgeCommand(message, content) {
  if (!message.guild) return;

  if (!canPurge(message)) {
    await message.reply('Command ini cuma buat Administrator / yang punya izin Manage Messages yaa 🙏');
    return;
  }

  const arg = content.split(/\s+/)[1];
  const amount = parseInt(arg, 10);
  if (!arg || !/^\d+$/.test(arg) || amount < 1 || amount > MAX_PURGE) {
    await replyTemp(message, `Format: \`!hapus <jumlah>\` (1–${MAX_PURGE}). Contoh: \`!hapus 10\``);
    return;
  }

  const me = message.guild.members.me;
  const botPerms = message.channel.permissionsFor(me);
  if (
    !botPerms?.has(PermissionsBitField.Flags.ManageMessages) ||
    !botPerms?.has(PermissionsBitField.Flags.ReadMessageHistory)
  ) {
    await replyTemp(message, 'Bot butuh izin **Manage Messages** dan **Read Message History** di channel ini.');
    return;
  }

  // Hapus pesan perintahnya dulu, supaya yang dihitung benar-benar N pesan sebelumnya.
  await message.delete().catch(() => {});

  try {
    // filterOld = true: pesan > 14 hari dilewati (batasan Discord, gak bisa di-bulk delete)
    const deleted = await message.channel.bulkDelete(amount, true);
    let text = `🧹 ${deleted.size} pesan dihapus oleh <@${message.author.id}>.`;
    if (deleted.size < amount) {
      text += `\n(Sisanya gak kehapus: pesan lebih dari 14 hari gak bisa dihapus massal oleh Discord.)`;
    }
    await replyTemp(message, text);
  } catch (err) {
    console.error('Gagal bulkDelete:', err);
    await replyTemp(message, 'Gagal menghapus pesan, coba lagi sebentar.');
  }
}

// ====== 2. Filter konten seksual ======

const SEXUAL_ENABLED = (process.env.AUTOMOD_SEXUAL_ENABLED || 'true').toLowerCase() !== 'false';

// Normalisasi: huruf kecil, leetspeak (k0nt0l → kontol), huruf berulang diringkas
// (kontoool → kontol). Daftar kata dinormalisasi dengan cara yang sama.
function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[0]/g, 'o')
    .replace(/[1!|]/g, 'i')
    .replace(/[3]/g, 'e')
    .replace(/[4@]/g, 'a')
    .replace(/[5$]/g, 's')
    .replace(/(.)\1+/g, '$1');
}

const DEFAULT_SEXUAL_WORDS = [
  // Indonesia
  'kontol', 'memek', 'pepek', 'ngentot', 'entot', 'ngewe', 'bokep', 'bugil', 'telanjang',
  'toket', 'itil', 'peju', 'colmek', 'coli', 'sange', 'jembut', 'tytyd', 'pantat montok',
  // English
  'porn', 'porno', 'pornhub', 'xnxx', 'xvideos', 'nude', 'nudes', 'hentai', 'blowjob',
  'handjob', 'cumshot', 'dick pic', 'sex video', 'send nudes', 'onlyfans',
];

const csv = (v) => (v || '').split(',').map((w) => w.trim()).filter(Boolean);
const allow = new Set(csv(process.env.AUTOMOD_SEXUAL_ALLOW).map(normalize));

const SEXUAL_WORDS = [...DEFAULT_SEXUAL_WORDS, ...csv(process.env.AUTOMOD_SEXUAL_WORDS)]
  .map(normalize)
  .filter((w) => w && !allow.has(w));

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Cocokkan sebagai KATA UTUH supaya gak salah hapus kata biasa yang kebetulan mengandung
// potongan huruf yang sama (misal "coli" di dalam kata lain).
const SEXUAL_REGEX = SEXUAL_WORDS.length
  ? new RegExp(`(^|[^a-z])(${SEXUAL_WORDS.map(escapeRegex).join('|')})(?=[^a-z]|$)`)
  : null;

function containsSexualContent(content) {
  if (!SEXUAL_ENABLED || !SEXUAL_REGEX || !content) return false;
  return SEXUAL_REGEX.test(normalize(content));
}

module.exports = { handlePurgeCommand, containsSexualContent };
