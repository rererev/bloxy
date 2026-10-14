// honeypot.js — channel jebakan untuk bot spam / akun yang kena hack.
//
// Siapa pun (non-staff) yang kirim pesan di channel honeypot langsung:
//   1. pesannya dihapus,
//   2. di-kick dari server, dan pesan-pesan terbarunya di SEMUA channel ikut terhapus.
//
// Cara hapus semua pesan sekaligus: "softban" = ban lalu langsung unban, dengan opsi
// deleteMessageSeconds. Hasil akhirnya sama seperti kick (user keluar & bisa join lagi),
// tapi pesan di semua channel ikut bersih. Kalau bot gak punya izin Ban, otomatis fallback ke kick biasa.
//
// Command (khusus Administrator):
//   !honeypot                 → lihat status
//   !honeypot set [#channel]  → jadikan channel honeypot (default: channel tempat command diketik)
//   !honeypot hapus [#channel] → matikan honeypot di channel itu
//
// ENV opsional:
//   HONEYPOT_CHANNEL_ID        ID channel honeypot (boleh banyak, pisah koma) — digabung dengan yang di-set via command
//   HONEYPOT_ACTION            softban (default) | kick
//   HONEYPOT_DELETE_HOURS      pesan berapa jam terakhir yang dihapus saat softban (default 24, maks 168)
//   HONEYPOT_LOG_CHANNEL_ID    channel buat laporan tiap ada yang kena jebakan (opsional)

const fs = require('fs');
const path = require('path');
const { EmbedBuilder, PermissionsBitField } = require('discord.js');

const DATA_DIR = process.env.DATA_DIR ? process.env.DATA_DIR : __dirname;
const FILE = path.join(DATA_DIR, 'honeypot.json');
const NO_PING = { parse: [], repliedUser: false };

const ACTION = (process.env.HONEYPOT_ACTION || 'softban').toLowerCase() === 'kick' ? 'kick' : 'softban';
const DELETE_HOURS = Math.min(168, Math.max(1, parseInt(process.env.HONEYPOT_DELETE_HOURS || '24', 10) || 24));
const LOG_CHANNEL_ID = (process.env.HONEYPOT_LOG_CHANNEL_ID || '').trim();

const csv = (v) => (v || '').split(',').map((x) => x.trim()).filter(Boolean);
const envChannels = new Set(csv(process.env.HONEYPOT_CHANNEL_ID));

let savedChannels = new Set();
try {
  if (fs.existsSync(FILE)) savedChannels = new Set(JSON.parse(fs.readFileSync(FILE, 'utf-8')).channels || []);
} catch (err) {
  console.error('[Honeypot] Gagal load honeypot.json:', err);
}

function save() {
  try {
    fs.writeFileSync(FILE, JSON.stringify({ channels: [...savedChannels] }, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Honeypot] Gagal simpan honeypot.json:', err);
  }
}

const isHoneypot = (channelId) => envChannels.has(channelId) || savedChannels.has(channelId);

// Staff dikecualikan supaya admin/mod bisa pasang pengumuman di channel honeypot tanpa kena kick.
function isStaff(member) {
  const p = member?.permissions;
  if (!p) return false;
  return [
    PermissionsBitField.Flags.Administrator,
    PermissionsBitField.Flags.ManageGuild,
    PermissionsBitField.Flags.ManageMessages,
    PermissionsBitField.Flags.KickMembers,
    PermissionsBitField.Flags.BanMembers,
  ].some((flag) => p.has(flag));
}

const handling = new Set(); // "guildId:userId" yang lagi diproses (anti dobel kalau spam banyak pesan sekaligus)

async function sendLog(guild, text) {
  if (!LOG_CHANNEL_ID) return;
  const ch = await guild.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
  if (ch?.send) await ch.send({ content: text, allowedMentions: { parse: [] } }).catch(() => {});
}

async function purgeUserInChannel(channel, userId) {
  try {
    const batch = await channel.messages.fetch({ limit: 100 });
    const mine = batch.filter((m) => m.author.id === userId);
    if (mine.size > 0) await channel.bulkDelete(mine, true);
    return mine.size;
  } catch (err) {
    console.error('[Honeypot] Gagal bersihin pesan di channel:', err.message);
    return 0;
  }
}

async function triggerHoneypot(message) {
  const { guild, channel, author } = message;
  const key = `${guild.id}:${author.id}`;

  // Pesan jebakan selalu dihapus duluan
  await message.delete().catch(() => {});

  if (handling.has(key)) return; // sudah diproses, cukup hapus pesannya
  handling.add(key);
  setTimeout(() => handling.delete(key), 30 * 1000);

  const reason = 'Honeypot: kirim pesan di channel jebakan';

  // Kasih tahu user (kalau DM-nya terbuka) — berguna kalau yang kena itu akun asli yang kena hack
  await author
    .send(
      `Kamu dikeluarkan dari **${guild.name}** karena mengirim pesan di channel jebakan anti-spam. ` +
        'Kalau ini bukan kamu, kemungkinan akunmu kena hack/bot — ganti password, aktifkan 2FA, lalu kamu boleh join lagi.'
    )
    .catch(() => {});

  let method = null;
  let unbanFailed = false;

  if (ACTION === 'softban') {
    try {
      await guild.members.ban(author.id, { deleteMessageSeconds: DELETE_HOURS * 3600, reason });
      method = 'softban';
      try {
        await guild.members.unban(author.id, 'Honeypot: unban otomatis setelah softban');
      } catch (err) {
        try {
          await guild.members.unban(author.id, 'Honeypot: unban otomatis (percobaan ulang)');
        } catch (err2) {
          unbanFailed = true;
          console.error('[Honeypot] Unban gagal:', err2.message);
        }
      }
    } catch (err) {
      console.error('[Honeypot] Softban gagal, fallback ke kick:', err.message);
    }
  }

  let cleaned = 0;
  if (!method) {
    try {
      const member = message.member || (await guild.members.fetch(author.id));
      await member.kick(reason);
      method = 'kick';
    } catch (err) {
      method = 'gagal';
      console.error('[Honeypot] Kick gagal:', err.message);
    }
    cleaned = await purgeUserInChannel(channel, author.id);
  }

  const scope =
    method === 'softban' ? `pesan ${DELETE_HOURS} jam terakhir di semua channel dihapus` : `${cleaned} pesan di channel jebakan dihapus`;
  let text = `🍯 **Honeypot kena!** ${author.tag} (\`${author.id}\`) kirim pesan di <#${channel.id}> → ${method === 'gagal' ? '⚠️ gagal di-kick (cek izin bot & posisi role)' : `${method === 'softban' ? 'di-kick (softban)' : 'di-kick'}, ${scope}`}.`;
  if (unbanFailed) text += `\n⚠️ Unban otomatis gagal — user ini masih ke-ban, tolong unban manual.`;
  console.log(text.replace(/\n/g, ' '));
  await sendLog(guild, text);
}

// ---- Command admin ----

async function handleHoneypotCommand(message, content) {
  if (!message.member?.permissions?.has(PermissionsBitField.Flags.Administrator)) {
    await message.reply('Command ini cuma buat Administrator yaa 🙏');
    return;
  }

  const [, sub, ...rest] = content.trim().split(/\s+/);
  const mentioned = message.mentions.channels?.first();
  const target = mentioned || message.channel;

  if (!sub) {
    const all = new Set([...envChannels, ...savedChannels]);
    const list = all.size ? [...all].map((id) => `<#${id}>`).join(', ') : '_belum ada_';
    await message.reply({
      content: `🍯 **Honeypot** — channel jebakan: ${list}\nMode: **${ACTION}**${ACTION === 'softban' ? ` (hapus pesan ${DELETE_HOURS} jam terakhir)` : ''}\nPasang: \`!honeypot set #channel\` • Matikan: \`!honeypot hapus #channel\``,
      allowedMentions: NO_PING,
    });
    return;
  }

  if (sub.toLowerCase() === 'set') {
    savedChannels.add(target.id);
    save();
    const embed = new EmbedBuilder()
      .setTitle('🚫 JANGAN KIRIM PESAN DI SINI')
      .setDescription(
        'Ini channel jebakan anti-bot. **Siapa pun yang mengirim pesan di channel ini akan otomatis di-kick** dan pesannya dihapus.\n\nKalau kamu manusia, abaikan saja channel ini.'
      );
    await target.send({ embeds: [embed] }).catch(() => {});
    await message.reply({ content: `✅ <#${target.id}> sekarang jadi channel honeypot.`, allowedMentions: NO_PING });
    return;
  }

  if (['hapus', 'off', 'matikan'].includes(sub.toLowerCase())) {
    if (envChannels.has(target.id)) {
      await message.reply('Channel ini di-set lewat variabel `HONEYPOT_CHANNEL_ID`, hapus dari variabel Railway kalau mau mematikannya.');
      return;
    }
    const had = savedChannels.delete(target.id);
    save();
    await message.reply({ content: had ? `✅ Honeypot di <#${target.id}> dimatikan.` : 'Channel itu bukan honeypot.', allowedMentions: NO_PING });
    return;
  }

  await message.reply('Format: `!honeypot` / `!honeypot set #channel` / `!honeypot hapus #channel`');
}

/**
 * Panggil di AWAL messageCreate. Return true kalau pesan sudah ditangani (jangan diproses lagi).
 */
async function handleHoneypotMessage(message) {
  if (!message.guild || message.author?.bot || message.webhookId) return false;

  const content = message.content || '';
  if (/^!honeypot(\s|$)/i.test(content)) {
    await handleHoneypotCommand(message, content);
    return true;
  }

  if (!isHoneypot(message.channel.id)) return false;
  if (isStaff(message.member)) return false;

  await triggerHoneypot(message);
  return true;
}

module.exports = { handleHoneypotMessage };
