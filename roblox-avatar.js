// roblox-avatar.js — tampilkan avatar Roblox lewat command berawalan "!" (digabung dari bot roblox-avatar-bot).
//
// Pasang di index.js (satu baris, setelah `const client = new Client(...)`):
//   require('./roblox-avatar')(client);
//
//   !usn <username>      → gambar avatar full body + tombol Full Body / Close Up / Refresh / Profil
//   !avatar <username>   → sama (alias)
//
// ENV opsional:
//   AVATAR_CHANNEL_ID   batasi command ke channel tertentu (pisah koma). Kosong = semua channel.
//
// Bot butuh izin: Send Messages + Embed Links (supaya link gambar tampil sebagai gambar).

const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const csv = (v) => (v || '').split(',').map((x) => x.trim()).filter(Boolean);
const ALLOWED_CHANNELS = new Set(csv(process.env.AVATAR_CHANNEL_ID));

const COOLDOWN_MS = 5 * 1000; // jeda per orang supaya API Roblox gak kena spam
const FETCH_TIMEOUT_MS = 8 * 1000;
const USERNAME_REGEX = /^[A-Za-z0-9_]{3,20}$/; // aturan username Roblox
const COMMAND_REGEX = /^!(usn|avatar)(?=\s|$)(?:\s+(\S+))?/i;

const lastUse = new Map(); // userId -> timestamp

// ---------- Roblox API ----------

async function robloxFetch(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function findUserByName(username) {
  const data = await robloxFetch('https://users.roblox.com/v1/usernames/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
  });
  return data?.data?.[0] || null; // { id, name, displayName } atau null kalau gak ada
}

// Roblox merender thumbnail secara async: state bisa "Pending" sebentar, jadi dicoba beberapa kali.
async function getAvatarImage(userId, headshot) {
  const kind = headshot ? 'avatar-headshot' : 'avatar';
  const url = `https://thumbnails.roblox.com/v1/users/${kind}?userIds=${userId}&size=720x720&format=Png&isCircular=false`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const data = await robloxFetch(url);
    const item = data?.data?.[0];
    if (item?.state === 'Completed' && item.imageUrl) return item.imageUrl;
    if (item?.state && item.state !== 'Pending') return null; // Blocked / Error: gak perlu diulang
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

// Info lagi main apa (kalau API-nya bisa diakses tanpa login; kalau gagal, tombol game tidak muncul)
async function getPresence(userId) {
  try {
    const data = await robloxFetch('https://presence.roblox.com/v1/presence/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userIds: [userId] }),
      timeout: 5000,
    });
    const p = data?.userPresences?.[0];
    if (!p || p.userPresenceType !== 2 || !p.placeId) return null;
    let gameName = 'Roblox Game';
    try {
      const games = await robloxFetch(`https://games.roblox.com/v1/games/multiget-place-details?placeIds=${p.placeId}`, { timeout: 5000 });
      gameName = games?.[0]?.name || gameName;
    } catch {
      /* nama game opsional */
    }
    return { placeId: p.placeId, gameName };
  } catch {
    return null;
  }
}

// ---------- Tombol ----------

function buildButtons(userId, headshot, presence) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`avatar:full:${userId}`)
      .setLabel('Full Body')
      .setEmoji('🧍')
      .setStyle(headshot ? ButtonStyle.Secondary : ButtonStyle.Primary)
      .setDisabled(!headshot),
    new ButtonBuilder()
      .setCustomId(`avatar:head:${userId}`)
      .setLabel('Close Up')
      .setEmoji('🔍')
      .setStyle(headshot ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(headshot),
    new ButtonBuilder()
      .setCustomId(`avatar:refresh:${userId}:${headshot ? 'h' : 'f'}`) // refresh tetap di tampilan yang sama
      .setLabel('Refresh')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setLabel('Profil')
      .setEmoji('🔗')
      .setStyle(ButtonStyle.Link)
      .setURL(`https://www.roblox.com/users/${userId}/profile`)
  );

  const rows = [row];
  if (presence) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel(`🕹️ ${presence.gameName}`.slice(0, 80))
          .setStyle(ButtonStyle.Link)
          .setURL(`https://www.roblox.com/games/${presence.placeId}`)
      )
    );
  }
  return rows;
}

async function buildReply(userId, headshot) {
  const [imageUrl, presence] = await Promise.all([getAvatarImage(userId, headshot), getPresence(userId)]);
  if (!imageUrl) {
    return { content: '⚠️ Gambar avatarnya belum siap atau tidak tersedia. Coba klik **Refresh** beberapa detik lagi.', components: buildButtons(userId, headshot, null) };
  }
  // Isi pesan = link gambar saja, Discord menampilkannya sebagai gambar (tanpa embed)
  return { content: imageUrl, embeds: [], components: buildButtons(userId, headshot, presence) };
}

// ---------- Handler ----------

async function handleCommand(message, rawUsername) {
  if (!rawUsername) {
    await message.reply({ content: '❗ Contoh: `!usn Builderman`', allowedMentions: { repliedUser: false } });
    return;
  }
  if (!USERNAME_REGEX.test(rawUsername)) {
    await message.reply({ content: '❌ Username Roblox harus 3–20 karakter (huruf, angka, atau underscore).', allowedMentions: { repliedUser: false } });
    return;
  }

  const now = Date.now();
  const wait = (lastUse.get(message.author.id) || 0) + COOLDOWN_MS - now;
  if (wait > 0) {
    await message.reply({ content: `Tunggu ${Math.ceil(wait / 1000)} detik dulu yaa.`, allowedMentions: { repliedUser: false } });
    return;
  }
  lastUse.set(message.author.id, now);
  if (lastUse.size > 500) for (const [id, t] of lastUse) if (now - t > 60 * 1000) lastUse.delete(id);

  const loading = await message.reply({ content: '⏳ Loading...', allowedMentions: { repliedUser: false } });
  try {
    const user = await findUserByName(rawUsername);
    if (!user) {
      await loading.edit({ content: `❌ Username **${rawUsername}** tidak ditemukan di Roblox.`, components: [] });
      return;
    }
    await loading.edit(await buildReply(user.id, false));
  } catch (err) {
    console.error('[RobloxAvatar] Gagal ambil data:', err.message);
    await loading.edit({ content: '❌ Gagal mengambil data dari Roblox (mungkin lagi sibuk). Coba lagi sebentar.', components: [] }).catch(() => {});
  }
}

async function handleButton(interaction) {
  const [, action, userId, mode] = interaction.customId.split(':');
  if (!/^\d+$/.test(userId || '')) return;

  await interaction.deferUpdate();
  try {
    const headshot = action === 'head' || (action === 'refresh' && mode === 'h');
    await interaction.editReply(await buildReply(userId, headshot));
  } catch (err) {
    console.error('[RobloxAvatar] Gagal refresh avatar:', err.message);
    await interaction.followUp({ content: '❌ Gagal mengambil data dari Roblox. Coba lagi sebentar.', ephemeral: true }).catch(() => {});
  }
}

module.exports = function initRobloxAvatar(client) {
  client.on('messageCreate', async (message) => {
    try {
      if (!message.guild || message.author?.bot || message.webhookId) return;
      const m = (message.content || '').match(COMMAND_REGEX);
      if (!m) return;
      if (ALLOWED_CHANNELS.size && !ALLOWED_CHANNELS.has(message.channel.id)) return;
      await handleCommand(message, m[2]);
    } catch (err) {
      console.error('[RobloxAvatar] Error command:', err);
    }
  });

  client.on('interactionCreate', async (interaction) => {
    try {
      if (!interaction.isButton() || !interaction.customId.startsWith('avatar:')) return;
      await handleButton(interaction);
    } catch (err) {
      console.error('[RobloxAvatar] Error tombol:', err);
    }
  });
};
