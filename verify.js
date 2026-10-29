// verify.js — verifikasi member baru lewat tombol, supaya channel lain baru kebuka setelah verifikasi.
//
// Pasang di index.js (satu baris, setelah `const client = new Client(...)`):
//   require('./verify')(client);
//
// Cara kerja: bot memasang panel (embed + tombol "Verifikasi") di channel verifikasi. Member klik tombol,
// lalu lolos tantangan sesuai MODE, dan bot memberi role "terverifikasi" yang sudah kamu buat.
//
// MODE:
//   kode  (disarankan) → member harus baca channel rules, temukan KODE RAHASIA, lalu ngetik kodenya di form.
//                        Bot spam massal gak baca rules, jadi gak bisa lolos.
//   soal               → soal penjumlahan dengan 4 pilihan tombol (mudah dijawab bot otomatis, kurang aman).
//   off                → tombol langsung memberi role (tanpa tantangan).
//
// Command (khusus Administrator):
//   !verifikasi                                   → lihat pengaturan
//   !verifikasi pasang @role [#channel] [teks]    → pasang panel (teks = isi panel, opsional)
//   !verifikasi kode <kode rahasia> [| pertanyaan] → set kode & nyalakan mode kode.
//                                                    Contoh: !verifikasi kode ikan-emas | Apa kode rahasia di #rules?
//   !verifikasi mode kode|soal|off                → ganti mode
//   !verifikasi hapus                             → matikan verifikasi
//
// PENTING (diatur di Discord, bukan di bot): @everyone cuma boleh lihat channel verifikasi + rules,
// dan role terverifikasi yang boleh lihat channel lain.

const fs = require('fs');
const path = require('path');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionsBitField,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const DATA_DIR = process.env.DATA_DIR ? process.env.DATA_DIR : __dirname;
const FILE = path.join(DATA_DIR, 'verify.json');
const NO_PING = { parse: [], repliedUser: false };

const PANEL_TEXT = {
  kode:
    'Selamat datang! 👋\nBaca dulu aturan server, temukan **kode rahasia** di dalamnya, lalu klik tombol **Verifikasi** dan masukkan kodenya. Semua channel akan kebuka setelah itu.',
  soal: 'Selamat datang! 👋\nKlik tombol **Verifikasi** di bawah untuk membuktikan kamu bukan bot, lalu semua channel akan kebuka.',
  off: 'Selamat datang! 👋\nKlik tombol **Verifikasi** di bawah, lalu semua channel akan kebuka.',
};
const DEFAULT_QUESTION = 'Kode rahasia dari channel rules';
const SUCCESS_TEXT = '✅ Verifikasi berhasil! Selamat datang, semua channel sudah kebuka.';

const CAPTCHA_TTL_MS = 60 * 1000;
const WRONG_COOLDOWN_MS = 5 * 1000;
const MAX_WRONG = 3; // salah kode sebanyak ini dalam WRONG_WINDOW_MS → kena jeda panjang
const WRONG_WINDOW_MS = 10 * 60 * 1000;
const LOCK_MS = 5 * 60 * 1000;

// { [guildId]: { roleId, channelId, messageId, mode, code, question, panelText } }
let config = {};
try {
  if (fs.existsSync(FILE)) config = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
} catch (err) {
  console.error('[Verify] Gagal load verify.json:', err);
}
// Migrasi data versi lama (captcha true/false → mode soal/off)
for (const cfg of Object.values(config)) {
  if (!cfg.mode) cfg.mode = cfg.captcha === false ? 'off' : 'soal';
  delete cfg.captcha;
}
function save() {
  try {
    fs.writeFileSync(FILE, JSON.stringify(config, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Verify] Gagal simpan verify.json:', err);
  }
}

const pending = new Map(); // "guildId:userId" -> { answer, expires }  (mode soal)
const cooldown = new Map(); // "guildId:userId" -> timestamp boleh coba lagi
const wrongTries = new Map(); // "guildId:userId" -> { count, first }

const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rand(0, i);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

function buildPanel(cfg) {
  const embed = new EmbedBuilder()
    .setTitle('✅ Verifikasi Member')
    .setDescription((cfg && cfg.panelText) || PANEL_TEXT[(cfg && cfg.mode) || 'kode']);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('verify:start').setLabel('Verifikasi').setEmoji('✅').setStyle(ButtonStyle.Success)
  );
  return { embeds: [embed], components: [row] };
}

// Perbarui teks panel yang sudah terpasang (setelah ganti mode / kode)
async function refreshPanel(guild, cfg) {
  try {
    const ch = await guild.channels.fetch(cfg.channelId);
    const msg = await ch.messages.fetch(cfg.messageId);
    await msg.edit(buildPanel(cfg));
    return true;
  } catch (err) {
    return false;
  }
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

function modeLabel(cfg) {
  if (cfg.mode === 'kode') return cfg.code ? 'kode rahasia (dari rules)' : 'kode rahasia — ⚠️ kodenya belum di-set';
  return cfg.mode === 'soal' ? 'soal penjumlahan' : 'tanpa tantangan (langsung)';
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
        ? `✅ **Verifikasi aktif**\nRole terverifikasi: <@&${cfg.roleId}>\nPanel: <#${cfg.channelId}>\nMode: **${modeLabel(cfg)}**\n\nGanti mode: \`!verifikasi mode kode|soal|off\` • Set kode: \`!verifikasi kode <kode>\``
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

    const next = {
      roleId: role.id,
      channelId: channel.id,
      messageId: null,
      mode: cfg?.mode || 'soal', // sampai kode di-set, pakai soal supaya gak ada member yang terkunci
      code: cfg?.code || '',
      question: cfg?.question || '',
      panelText: text || null,
    };

    let sent;
    try {
      sent = await channel.send(buildPanel(next));
    } catch (err) {
      await message.reply({ content: `Gagal kirim panel ke <#${channel.id}>. Cek izin bot di channel itu.`, allowedMentions: NO_PING });
      return;
    }

    next.messageId = sent.id;
    config[guild.id] = next;
    save();
    await message.reply({
      content:
        `✅ Panel verifikasi terpasang di <#${channel.id}>. Member yang lolos akan dapat role **${role.name}**.\n` +
        `Mode sekarang: **${modeLabel(next)}**. Untuk mode paling aman, set kode rahasia (taruh kodenya di channel rules): \`!verifikasi kode <kode>\`\n` +
        `Jangan lupa atur izin channel di Discord: @everyone cuma lihat channel verifikasi + rules, role **${role.name}** yang lihat channel lain.`,
      allowedMentions: NO_PING,
    });
    return;
  }

  if (sub === 'kode') {
    if (!cfg) {
      await message.reply('Pasang verifikasi dulu pakai `!verifikasi pasang @role #channel`.');
      return;
    }
    const raw = content.replace(/^!verifikasi\s+kode\s*/i, '');
    const [codePart, ...qParts] = raw.split('|');
    const code = codePart.trim();
    const question = qParts.join('|').trim();

    if (!code) {
      await message.reply('Format: `!verifikasi kode <kode rahasia> [| pertanyaan]`\nContoh: `!verifikasi kode ikan-emas | Apa kode rahasia di #rules?`');
      return;
    }
    if (code.length > 100) {
      await message.reply('Kodenya kepanjangan (maks 100 karakter).');
      return;
    }

    cfg.code = code;
    cfg.question = question.slice(0, 45); // batas label form di Discord
    cfg.mode = 'kode';
    save();
    const refreshed = await refreshPanel(guild, cfg);

    // Hapus pesan command supaya kode gak nongkrong di chat
    const deleted = await message.delete().then(() => true).catch(() => false);
    await message.channel.send({
      content:
        `✅ Mode **kode rahasia** aktif${refreshed ? ' dan teks panel diperbarui' : ' (panel gagal diperbarui, pasang ulang kalau perlu)'}.\n` +
        `Taruh kode itu di channel rules supaya member bisa menemukannya.${deleted ? '' : '\n⚠️ Aku gak bisa hapus pesan tadi — hapus manual supaya kodenya gak kelihatan.'}\n` +
        'Tips: ketik command ini di channel khusus admin.',
      allowedMentions: NO_PING,
    });
    return;
  }

  if (sub === 'mode' || sub === 'soal') {
    // "!verifikasi soal on|off" dari versi lama tetap jalan
    const arg = (content.trim().split(/\s+/)[2] || '').toLowerCase();
    const mode = sub === 'soal' ? (arg === 'on' ? 'soal' : arg === 'off' ? 'off' : '') : arg;
    if (!cfg || !['kode', 'soal', 'off'].includes(mode)) {
      await message.reply(cfg ? 'Format: `!verifikasi mode kode` / `soal` / `off`' : 'Pasang verifikasi dulu pakai `!verifikasi pasang @role #channel`.');
      return;
    }
    if (mode === 'kode' && !cfg.code) {
      await message.reply('Set kodenya dulu: `!verifikasi kode <kode rahasia>`');
      return;
    }
    cfg.mode = mode;
    save();
    await refreshPanel(guild, cfg);
    await message.reply(`✅ Mode verifikasi sekarang: **${modeLabel(cfg)}**.`);
    return;
  }

  if (sub === 'hapus') {
    delete config[guild.id];
    save();
    await message.reply('✅ Verifikasi dimatikan. Tombol di panel lama berhenti memberi role (hapus panelnya manual kalau perlu).');
    return;
  }

  await message.reply('Format: `!verifikasi` / `!verifikasi pasang @role #channel` / `!verifikasi kode <kode>` / `!verifikasi mode kode|soal|off` / `!verifikasi hapus`');
}

// ---------- Interaksi member ----------

async function grantRole(interaction, cfg, useUpdate) {
  try {
    await interaction.member.roles.add(cfg.roleId, 'Verifikasi lewat tombol');
    if (useUpdate) await interaction.update({ content: SUCCESS_TEXT, components: [] });
    else await interaction.reply({ content: SUCCESS_TEXT, flags: MessageFlags.Ephemeral });
  } catch (err) {
    console.error('[Verify] Gagal kasih role:', err.message);
    const text = 'Maaf, aku gagal memberi role-nya. Kabari admin yaa 🙏';
    if (interaction.replied || interaction.deferred) await interaction.followUp({ content: text, flags: MessageFlags.Ephemeral }).catch(() => {});
    else await interaction.reply({ content: text, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
}

// true kalau user sedang kena jeda; sekalian balas pesannya
async function blockedByCooldown(interaction, key) {
  const wait = (cooldown.get(key) || 0) - Date.now();
  if (wait > 0) {
    const secs = Math.ceil(wait / 1000);
    const text = secs > 90 ? `Terlalu banyak salah. Coba lagi dalam ${Math.ceil(secs / 60)} menit.` : `Tunggu ${secs} detik dulu sebelum coba lagi.`;
    await interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
    return true;
  }
  return false;
}

function registerWrong(key) {
  const now = Date.now();
  const rec = wrongTries.get(key);
  if (!rec || now - rec.first > WRONG_WINDOW_MS) {
    wrongTries.set(key, { count: 1, first: now });
    cooldown.set(key, now + WRONG_COOLDOWN_MS);
    return false;
  }
  rec.count++;
  if (rec.count >= MAX_WRONG) {
    wrongTries.delete(key);
    cooldown.set(key, now + LOCK_MS);
    return true; // kena jeda panjang
  }
  cooldown.set(key, now + WRONG_COOLDOWN_MS);
  return false;
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
    if (cfg.mode === 'off') {
      await grantRole(interaction, cfg, false);
      return;
    }
    if (await blockedByCooldown(interaction, key)) return;

    if (cfg.mode === 'kode' && cfg.code) {
      const input = new TextInputBuilder()
        .setCustomId('code')
        .setLabel((cfg.question || DEFAULT_QUESTION).slice(0, 45))
        .setPlaceholder('Ketik kodenya di sini')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(100);
      const modal = new ModalBuilder()
        .setCustomId('verify:code')
        .setTitle('Verifikasi Member')
        .addComponents(new ActionRowBuilder().addComponents(input));
      await interaction.showModal(modal);
      return;
    }

    // mode soal (atau mode kode yang belum ada kodenya → pakai soal supaya member gak terkunci)
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
    await grantRole(interaction, cfg, true);
  }
}

async function handleModal(interaction) {
  const cfg = config[interaction.guildId];
  const eph = MessageFlags.Ephemeral;

  if (!cfg || cfg.mode !== 'kode' || !cfg.code) {
    await interaction.reply({ content: 'Verifikasi lagi gak aktif atau berubah. Klik tombol **Verifikasi** lagi yaa.', flags: eph });
    return;
  }
  if (interaction.member?.roles?.cache?.has(cfg.roleId)) {
    await interaction.reply({ content: 'Kamu sudah terverifikasi ✅', flags: eph });
    return;
  }

  const key = `${interaction.guildId}:${interaction.user.id}`;
  if (await blockedByCooldown(interaction, key)) return;

  const typed = norm(interaction.fields.getTextInputValue('code'));
  if (typed === norm(cfg.code)) {
    wrongTries.delete(key);
    await grantRole(interaction, cfg, false);
    return;
  }

  const locked = registerWrong(key);
  await interaction.reply({
    content: locked
      ? '❌ Kodenya salah lagi. Kamu kena jeda 5 menit — baca aturan server baik-baik dulu yaa.'
      : '❌ Kodenya salah. Baca lagi channel rules, kodenya ada di sana. Lalu klik **Verifikasi** buat coba lagi.',
    flags: eph,
  });
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
      if (!interaction.guildId) return;
      if (interaction.isButton() && interaction.customId.startsWith('verify:')) {
        await handleButton(interaction);
      } else if (interaction.isModalSubmit() && interaction.customId === 'verify:code') {
        await handleModal(interaction);
      }
    } catch (err) {
      console.error('[Verify] Error interaksi:', err);
    }
  });
};
