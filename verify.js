// verify.js — verifikasi member baru lewat tombol, supaya channel lain baru kebuka setelah verifikasi.
//
// Pasang di index.js (satu baris, setelah `const client = new Client(...)`):
//   require('./verify')(client);
//
// Cara kerja: bot memasang panel (embed + tombol "Verifikasi") di channel verifikasi. Member klik tombol,
// jawab soal penjumlahan singkat (anti-bot), lalu bot memberi role "terverifikasi" yang sudah kamu buat.
//
// Command (khusus Administrator):
//   !verifikasi                          → lihat pengaturan
//   !verifikasi pasang @role [#channel] [teks]  → pasang panel; @role = role terverifikasi,
//                                          #channel = tempat panel (default: channel ini), teks = isi panel (opsional)
//   !verifikasi soal on|off              → nyalakan / matikan soal anti-bot (default: on)
//   !verifikasi hapus                    → matikan verifikasi (tombol lama berhenti memberi role)
//
// PENTING (diatur di Discord, bukan di bot): @everyone cuma boleh lihat channel verifikasi,
// dan role terverifikasi yang boleh lihat channel lain.

const fs = require('fs');
const path = require('path');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  PermissionsBitField,
} = require('discord.js');

const DATA_DIR = process.env.DATA_DIR ? process.env.DATA_DIR : __dirname;
const FILE = path.join(DATA_DIR, 'verify.json');
const NO_PING = { parse: [], repliedUser: false };

const DEFAULT_TEXT =
  'Selamat datang! 👋\nKlik tombol **Verifikasi** di bawah untuk membuktikan kamu bukan bot, lalu semua channel akan kebuka.';
const CAPTCHA_TTL_MS = 60 * 1000;
const WRONG_COOLDOWN_MS = 5 * 1000;

// { [guildId]: { roleId, channelId, messageId, captcha } }
let config = {};
try {
  if (fs.existsSync(FILE)) config = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
} catch (err) {
  console.error('[Verify] Gagal load verify.json:', err);
}
function save() {
  try {
    fs.writeFileSync(FILE, JSON.stringify(config, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Verify] Gagal simpan verify.json:', err);
  }
}

const pending = new Map(); // "guildId:userId" -> { answer, expires }
const cooldown = new Map(); // "guildId:userId" -> timestamp boleh coba lagi

const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rand(0, i);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function buildPanel(text) {
  const embed = new EmbedBuilder().setTitle('✅ Verifikasi Member').setDescription(text || DEFAULT_TEXT);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('verify:start').setLabel('Verifikasi').setEmoji('✅').setStyle(ButtonStyle.Success)
  );
  return { embeds: [embed], components: [row] };
}

function buildQuestion() {
  const a = rand(2, 9);
  const b = rand(2, 9);
  const answer = a + b;
  const options = new Set([answer]);
  while (options.size < 4) {
    const wrong = answer + rand(-5, 5);
    if (wrong > 0) options.add(wrong);
  }
  const buttons = shuffle([...options]).map((n) =>
    new ButtonBuilder().setCustomId(`verify:ans:${n}`).setLabel(String(n)).setStyle(ButtonStyle.Secondary)
  );
  return { a, b, answer, row: new ActionRowBuilder().addComponents(buttons) };
}

// ---------- Command admin ----------

async function handleCommand(message, content) {
  if (!message.member?.permissions?.has(PermissionsBitField.Flags.Administrator)) {
    await message.reply('Command ini cuma buat Administrator yaa 🙏');
    return;
  }

  const guild = message.guild;
  const cfg = config[guild.id];
  const sub = (content.trim().split(/\s+/)[1] || '').toLowerCase();

  if (!sub) {
    await message.reply({
      content: cfg
        ? `✅ **Verifikasi aktif**\nRole terverifikasi: <@&${cfg.roleId}>\nPanel: <#${cfg.channelId}>\nSoal anti-bot: **${cfg.captcha ? 'on' : 'off'}**\n\nPasang ulang: \`!verifikasi pasang @role #channel\``
        : 'Verifikasi belum diatur. Pasang dengan:\n`!verifikasi pasang @role #channel`\n(@role = role terverifikasi yang sudah kamu buat, #channel = channel verifikasi)',
      allowedMentions: NO_PING,
    });
    return;
  }

  if (sub === 'pasang') {
    const role = message.mentions.roles?.first();
    const channel = message.mentions.channels?.first() || message.channel;
    if (!role) {
      await message.reply('Format: `!verifikasi pasang @role #channel [teks]` — mention role terverifikasi yang sudah kamu buat.');
      return;
    }

    const me = guild.members.me;
    if (role.id === guild.id) {
      await message.reply('Role @everyone gak bisa dipakai sebagai role verifikasi.');
      return;
    }
    if (role.managed) {
      await message.reply(`Role **${role.name}** dikelola integrasi/bot lain, jadi gak bisa dipakai.`);
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

    // Teks panel = sisa pesan setelah command, sub-command, dan semua mention
    const text = content
      .replace(/^!verifikasi\s+pasang\s*/i, '')
      .replace(/<@&\d+>|<#\d+>/g, '')
      .trim();

    let sent;
    try {
      sent = await channel.send(buildPanel(text));
    } catch (err) {
      await message.reply({ content: `Gagal kirim panel ke <#${channel.id}>. Cek izin bot di channel itu.`, allowedMentions: NO_PING });
      return;
    }

    config[guild.id] = {
      roleId: role.id,
      channelId: channel.id,
      messageId: sent.id,
      captcha: cfg ? cfg.captcha : true,
    };
    save();
    await message.reply({
      content: `✅ Panel verifikasi terpasang di <#${channel.id}>. Member yang klik tombol akan dapat role **${role.name}**.\nJangan lupa atur izin channel di Discord: @everyone cuma lihat channel verifikasi, role **${role.name}** yang lihat channel lain.`,
      allowedMentions: NO_PING,
    });
    return;
  }

  if (sub === 'soal') {
    const value = (content.trim().split(/\s+/)[2] || '').toLowerCase();
    if (!cfg || !['on', 'off'].includes(value)) {
      await message.reply(cfg ? 'Format: `!verifikasi soal on` atau `!verifikasi soal off`' : 'Pasang verifikasi dulu pakai `!verifikasi pasang @role #channel`.');
      return;
    }
    cfg.captcha = value === 'on';
    save();
    await message.reply(`✅ Soal anti-bot ${cfg.captcha ? 'dinyalakan' : 'dimatikan'}.`);
    return;
  }

  if (sub === 'hapus') {
    delete config[guild.id];
    save();
    await message.reply('✅ Verifikasi dimatikan. Tombol di panel lama berhenti memberi role (hapus panelnya manual kalau perlu).');
    return;
  }

  await message.reply('Format: `!verifikasi` / `!verifikasi pasang @role #channel` / `!verifikasi soal on|off` / `!verifikasi hapus`');
}

// ---------- Tombol ----------

async function grantRole(interaction, cfg, successText, useUpdate) {
  try {
    await interaction.member.roles.add(cfg.roleId, 'Verifikasi lewat tombol');
    if (useUpdate) {
      await interaction.update({ content: successText, components: [] });
    } else {
      await interaction.reply({ content: successText, flags: MessageFlags.Ephemeral });
    }
  } catch (err) {
    console.error('[Verify] Gagal kasih role:', err.message);
    const text = 'Maaf, aku gagal memberi role-nya. Kabari admin yaa 🙏';
    if (interaction.replied || interaction.deferred) await interaction.followUp({ content: text, flags: MessageFlags.Ephemeral }).catch(() => {});
    else await interaction.reply({ content: text, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
}

async function handleButton(interaction) {
  const cfg = config[interaction.guildId];
  const eph = MessageFlags.Ephemeral;

  if (!cfg) {
    await interaction.reply({ content: 'Verifikasi lagi gak aktif. Hubungi admin yaa.', flags: eph });
    return;
  }
  if (interaction.member?.roles?.cache?.has(cfg.roleId)) {
    await interaction.reply({ content: 'Kamu sudah terverifikasi ✅', flags: eph });
    return;
  }

  const key = `${interaction.guildId}:${interaction.user.id}`;

  if (interaction.customId === 'verify:start') {
    if (!cfg.captcha) {
      await grantRole(interaction, cfg, '✅ Verifikasi berhasil! Selamat datang, semua channel sudah kebuka.', false);
      return;
    }
    const wait = (cooldown.get(key) || 0) - Date.now();
    if (wait > 0) {
      await interaction.reply({ content: `Tunggu ${Math.ceil(wait / 1000)} detik dulu sebelum coba lagi.`, flags: eph });
      return;
    }
    const q = buildQuestion();
    pending.set(key, { answer: q.answer, expires: Date.now() + CAPTCHA_TTL_MS });
    await interaction.reply({ content: `Biar kebukti kamu bukan bot: **${q.a} + ${q.b} = ?**`, components: [q.row], flags: eph });
    return;
  }

  if (interaction.customId.startsWith('verify:ans:')) {
    const chosen = parseInt(interaction.customId.split(':')[2], 10);
    const p = pending.get(key);
    pending.delete(key);

    if (!p || p.expires < Date.now()) {
      await interaction.update({ content: 'Soalnya sudah kedaluwarsa. Klik tombol **Verifikasi** lagi yaa.', components: [] });
      return;
    }
    if (chosen !== p.answer) {
      cooldown.set(key, Date.now() + WRONG_COOLDOWN_MS);
      await interaction.update({ content: '❌ Jawabannya salah. Klik tombol **Verifikasi** lagi buat soal baru.', components: [] });
      return;
    }
    await grantRole(interaction, cfg, '✅ Verifikasi berhasil! Selamat datang, semua channel sudah kebuka.', true);
  }
}

module.exports = function initVerify(client) {
  client.on('messageCreate', async (message) => {
    try {
      if (!message.guild || message.author?.bot || message.webhookId) return;
      const content = message.content || '';
      if (!/^!verifikasi(\s|$)/i.test(content)) return;
      await handleCommand(message, content);
    } catch (err) {
      console.error('[Verify] Error command:', err);
    }
  });

  client.on('interactionCreate', async (interaction) => {
    try {
      if (!interaction.isButton() || !interaction.customId.startsWith('verify:') || !interaction.guildId) return;
      await handleButton(interaction);
    } catch (err) {
      console.error('[Verify] Error tombol:', err);
    }
  });
};
