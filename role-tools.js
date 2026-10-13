// role-tools.js — copot satu role dari SEMUA member yang punya role itu sekaligus.
//
//   !copotsemua @role      (alias: !removeroleall @role)
//
// Aman dipakai: khusus Administrator, ada konfirmasi sebelum jalan, role @everyone / role bot /
// role yang posisinya di atas role bot otomatis ditolak, dan tidak bisa jalan dobel di server yang sama.

const { PermissionsBitField } = require('discord.js');

const CONFIRM_MS = 30 * 1000;
const PROGRESS_EVERY = 25;
const running = new Set(); // guildId yang lagi diproses

const NO_PING = { parse: [], repliedUser: false };

function isAdmin(message) {
  return message.member?.permissions?.has(PermissionsBitField.Flags.Administrator) ?? false;
}

async function handleRemoveRoleAll(message) {
  if (!message.guild) return;

  if (!isAdmin(message)) {
    await message.reply('Command ini cuma buat Administrator yaa 🙏');
    return;
  }

  const role = message.mentions.roles?.first();
  if (!role) {
    await message.reply('Format: `!copotsemua @role` — mention role yang mau dicopot dari semua membernya.');
    return;
  }

  const guild = message.guild;
  const me = guild.members.me;

  // --- Pengecekan keamanan ---
  if (role.id === guild.id) {
    await message.reply('Role @everyone gak bisa dicopot.');
    return;
  }
  if (role.managed) {
    await message.reply(`Role **${role.name}** dikelola integrasi/bot lain, jadi gak bisa dicopot manual.`);
    return;
  }
  if (!me?.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    await message.reply('Bot belum punya izin **Manage Roles**.');
    return;
  }
  if (role.position >= me.roles.highest.position) {
    await message.reply(`Role **${role.name}** posisinya sejajar/di atas role bot. Naikkan role bot di atas **${role.name}** dulu di Server Settings → Roles.`);
    return;
  }
  if (running.has(guild.id)) {
    await message.reply('Masih ada proses copot role yang lagi jalan di server ini, tunggu sampai selesai yaa.');
    return;
  }

  // --- Ambil semua member yang punya role itu ---
  await message.channel.sendTyping().catch(() => {});
  try {
    await guild.members.fetch();
  } catch (err) {
    console.error('Gagal fetch members:', err);
    await message.reply('Gagal ambil daftar member (cek intent **Server Members** aktif di Developer Portal). Coba lagi sebentar.');
    return;
  }

  const targets = [...role.members.values()];
  if (targets.length === 0) {
    await message.reply({ content: `Gak ada member yang punya role **${role.name}**.`, allowedMentions: NO_PING });
    return;
  }

  // --- Konfirmasi ---
  await message.reply({
    content: `⚠️ Role **${role.name}** bakal dicopot dari **${targets.length} member**. Ketik **ya** dalam 30 detik buat lanjut, atau **batal**.`,
    allowedMentions: NO_PING,
  });

  let answer;
  try {
    const collected = await message.channel.awaitMessages({
      filter: (m) => m.author.id === message.author.id && /^(ya|batal)$/i.test(m.content.trim()),
      max: 1,
      time: CONFIRM_MS,
      errors: ['time'],
    });
    answer = collected.first().content.trim().toLowerCase();
  } catch {
    await message.channel.send('⏱️ Waktu konfirmasi habis, gak ada role yang dicopot.');
    return;
  }

  if (answer !== 'ya') {
    await message.channel.send('Dibatalkan, gak ada role yang dicopot.');
    return;
  }

  // --- Eksekusi ---
  running.add(guild.id);
  const reason = `Dicopot massal oleh ${message.author.tag}`;
  const status = await message.channel.send(`⏳ Mencopot **${role.name}**... 0/${targets.length}`);
  let ok = 0;
  const failed = [];

  try {
    for (let i = 0; i < targets.length; i++) {
      const member = targets[i];
      try {
        await member.roles.remove(role, reason);
        ok++;
      } catch (err) {
        failed.push(member.user.tag);
        console.error(`Gagal copot ${role.name} dari ${member.user.tag}:`, err.message);
      }
      if ((i + 1) % PROGRESS_EVERY === 0 && i + 1 < targets.length) {
        await status.edit(`⏳ Mencopot **${role.name}**... ${i + 1}/${targets.length}`).catch(() => {});
      }
    }
  } finally {
    running.delete(guild.id);
  }

  let summary = `✅ Selesai! Role **${role.name}** dicopot dari **${ok}** member.`;
  if (failed.length) {
    const shown = failed.slice(0, 10).join(', ');
    summary += `\n⚠️ ${failed.length} gagal: ${shown}${failed.length > 10 ? ', dll.' : ''}`;
  }
  await status.edit(summary).catch(() => message.channel.send(summary));
}

async function handleRoleToolsCommand(message, content) {
  const lower = content.toLowerCase();
  if (lower === '!copotsemua' || lower.startsWith('!copotsemua ') || lower === '!removeroleall' || lower.startsWith('!removeroleall ')) {
    await handleRemoveRoleAll(message);
    return true;
  }
  return false;
}

module.exports = { handleRoleToolsCommand };
