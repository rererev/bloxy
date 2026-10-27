// poll.js — voting pakai TOMBOL (bukan reaction), jadi 1 orang = 1 suara.
//
// Pasang di index.js (satu baris, setelah `const client = new Client(...)`):
//   require('./poll')(client);
//
//   !poll [durasi] Pertanyaan | opsi 1 | opsi 2 | ...     (khusus Administrator, 2–10 opsi)
//   contoh: !poll 2j Boss malam ini jam berapa? | Jam 8 | Jam 9 | Jam 10
//   durasi (opsional): 30m / 2j / 1d  (menit / jam / hari, maks 7 hari). Tanpa durasi = ditutup manual.
//
// Member klik tombol buat vote. Klik opsi lain = pindah suara, klik opsi yang sama lagi = tarik suara.
// Hasil tampil langsung sebagai bar persen. Tombol "Tutup poll" cuma bisa dipakai admin.
// Suara anonim (nama pemilih gak ditampilkan) dan tersimpan di polls.json, jadi aman dari redeploy.

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
const FILE = path.join(DATA_DIR, 'polls.json');
const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const SWEEP_MS = 15 * 1000; // cek poll yang sudah lewat waktunya tiap 15 detik
const KEEP_CLOSED = 50; // simpan maksimal segini poll yang sudah ditutup

// { [messageId]: { guildId, channelId, question, options[], votes{userId:index}, closed, endsAt, authorTag } }
let polls = {};
try {
  if (fs.existsSync(FILE)) polls = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
} catch (err) {
  console.error('[Poll] Gagal load polls.json:', err);
}

function save() {
  // buang poll tertutup yang paling lama supaya file gak membengkak
  const closed = Object.entries(polls).filter(([, p]) => p.closed);
  if (closed.length > KEEP_CLOSED) {
    closed
      .sort((a, b) => (a[1].closedAt || 0) - (b[1].closedAt || 0))
      .slice(0, closed.length - KEEP_CLOSED)
      .forEach(([id]) => delete polls[id]);
  }
  try {
    fs.writeFileSync(FILE, JSON.stringify(polls, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Poll] Gagal simpan polls.json:', err);
  }
}

const isAdmin = (member) => member?.permissions?.has(PermissionsBitField.Flags.Administrator) ?? false;

// ---------- Tampilan ----------

function tally(poll) {
  const counts = poll.options.map(() => 0);
  for (const idx of Object.values(poll.votes)) if (counts[idx] !== undefined) counts[idx]++;
  return counts;
}

function bar(pct) {
  const filled = Math.round(pct / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

function buildEmbed(poll) {
  const counts = tally(poll);
  const total = counts.reduce((a, b) => a + b, 0);
  const max = Math.max(...counts);

  const lines = poll.options.map((opt, i) => {
    const pct = total ? Math.round((counts[i] / total) * 100) : 0;
    const crown = poll.closed && total > 0 && counts[i] === max ? ' 👑' : '';
    return `**${i + 1}. ${opt}**${crown}\n${bar(pct)} **${pct}%** · ${counts[i]} suara`;
  });

  let footerLine;
  if (poll.closed) footerLine = '🔒 **Poll ditutup**';
  else if (poll.endsAt) footerLine = `⏳ Berakhir <t:${Math.floor(poll.endsAt / 1000)}:R>`;
  else footerLine = 'Klik tombol di bawah buat vote — 1 orang 1 suara.';

  return new EmbedBuilder()
    .setTitle(`📊 ${poll.question}`)
    .setDescription(`${lines.join('\n\n')}\n\n${footerLine}`)
    .setFooter({ text: `${total} suara • Poll oleh ${poll.authorTag}` });
}

function buildComponents(poll) {
  const rows = [];
  let row = new ActionRowBuilder();
  poll.options.forEach((opt, i) => {
    if (row.components.length === 5) {
      rows.push(row);
      row = new ActionRowBuilder();
    }
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`poll:v:${i}`)
        .setLabel(`${i + 1}. ${opt}`.slice(0, 80))
        .setStyle(ButtonStyle.Primary)
    );
  });
  rows.push(row);
  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('poll:close').setLabel('Tutup poll').setEmoji('🔒').setStyle(ButtonStyle.Secondary)
    )
  );
  return rows;
}

// ---------- Tutup poll ----------

async function closePoll(client, messageId) {
  const poll = polls[messageId];
  if (!poll || poll.closed) return;
  poll.closed = true;
  poll.closedAt = Date.now();
  save();

  try {
    const channel = await client.channels.fetch(poll.channelId);
    const msg = await channel.messages.fetch(messageId);
    await msg.edit({ embeds: [buildEmbed(poll)], components: [] });
  } catch (err) {
    console.error('[Poll] Gagal update pesan poll yang ditutup:', err.message);
  }
}

// ---------- Command ----------

const DURATION_REGEX = /^(\d+)\s*(m|menit|j|jam|h|d|hari)\b\s*/i;

function parseDuration(text) {
  const m = text.match(DURATION_REGEX);
  if (!m) return { ms: null, rest: text };
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const per = unit.startsWith('m') ? 60e3 : unit === 'd' || unit === 'hari' ? 86400e3 : 3600e3;
  return { ms: n * per, rest: text.slice(m[0].length) };
}

async function handleCommand(client, message, content) {
  if (!isAdmin(message.member)) {
    await message.reply('Command ini cuma buat Administrator yaa 🙏');
    return;
  }

  const body = content.replace(/^!poll\s*/i, '');
  const { ms, rest } = parseDuration(body);
  const parts = rest.split('|').map((p) => p.trim()).filter(Boolean);

  if (parts.length < 3 || parts.length > 11) {
    await message.reply(
      'Format: `!poll [durasi] Pertanyaan | opsi 1 | opsi 2 | ...` (2–10 opsi)\nContoh: `!poll 2j Boss malam ini? | Jam 8 | Jam 9`\nDurasi opsional: `30m` / `2j` / `1d` (maks 7 hari).'
    );
    return;
  }
  if (ms !== null && (ms < 60e3 || ms > MAX_DURATION_MS)) {
    await message.reply('Durasinya harus antara 1 menit sampai 7 hari.');
    return;
  }

  const [question, ...options] = parts;
  if (question.length > 200 || options.some((o) => o.length > 150)) {
    await message.reply('Pertanyaan maks 200 karakter dan tiap opsi maks 150 karakter yaa.');
    return;
  }

  const poll = {
    guildId: message.guild.id,
    channelId: message.channel.id,
    question,
    options,
    votes: {},
    closed: false,
    endsAt: ms ? Date.now() + ms : null,
    authorTag: message.member?.displayName || message.author.username,
  };

  const sent = await message.channel.send({ embeds: [buildEmbed(poll)], components: buildComponents(poll) });
  polls[sent.id] = poll;
  save();
  await message.delete().catch(() => {});
}

// ---------- Tombol ----------

async function handleButton(client, interaction) {
  const eph = MessageFlags.Ephemeral;
  const poll = polls[interaction.message.id];

  if (!poll) {
    await interaction.reply({ content: 'Poll ini sudah gak aktif (datanya sudah dihapus).', flags: eph });
    return;
  }

  if (interaction.customId === 'poll:close') {
    if (!isAdmin(interaction.member)) {
      await interaction.reply({ content: 'Cuma Administrator yang bisa menutup poll.', flags: eph });
      return;
    }
    poll.closed = true;
    poll.closedAt = Date.now();
    save();
    await interaction.update({ embeds: [buildEmbed(poll)], components: [] });
    return;
  }

  if (poll.closed) {
    await interaction.reply({ content: 'Poll ini sudah ditutup.', flags: eph });
    return;
  }
  if (poll.endsAt && poll.endsAt <= Date.now()) {
    await closePoll(client, interaction.message.id);
    await interaction.reply({ content: 'Waktu poll ini sudah habis.', flags: eph });
    return;
  }

  const idx = parseInt(interaction.customId.split(':')[2], 10);
  if (!(idx >= 0 && idx < poll.options.length)) return;

  const uid = interaction.user.id;
  if (poll.votes[uid] === idx) delete poll.votes[uid]; // klik opsi yang sama = tarik suara
  else poll.votes[uid] = idx; // 1 orang cuma 1 suara; klik opsi lain = pindah suara
  save();

  await interaction.update({ embeds: [buildEmbed(poll)], components: buildComponents(poll) });
}

module.exports = function initPoll(client) {
  // Sapuan berkala: tutup poll yang durasinya sudah habis (termasuk yang habis waktu saat bot mati)
  const sweep = setInterval(() => {
    if (!client.isReady?.()) return;
    for (const [id, p] of Object.entries(polls)) {
      if (!p.closed && p.endsAt && p.endsAt <= Date.now()) closePoll(client, id);
    }
  }, SWEEP_MS);
  if (sweep.unref) sweep.unref();

  client.on('messageCreate', async (message) => {
    try {
      if (!message.guild || message.author?.bot || message.webhookId) return;
      const content = message.content || '';
      if (!/^!poll(\s|$)/i.test(content)) return;
      await handleCommand(client, message, content);
    } catch (err) {
      console.error('[Poll] Error command:', err);
    }
  });

  client.on('interactionCreate', async (interaction) => {
    try {
      if (!interaction.isButton() || !interaction.customId.startsWith('poll:') || !interaction.guildId) return;
      await handleButton(client, interaction);
    } catch (err) {
      console.error('[Poll] Error tombol:', err);
    }
  });
};

