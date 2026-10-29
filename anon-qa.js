// anon-qa.js — sesi tanya jawab ANONIM. Member kirim pertanyaan lewat tombol + form, bot yang memostingnya
// (jadi nama pengirim gak muncul di mana pun di server), lalu admin membalas lewat tombol "Jawab".
//
// Pasang di index.js (satu baris, setelah `const client = new Client(...)`):
//   require('./anon-qa')(client);
//
// Command (khusus Administrator):
//   !anonim pasang [#channel]   → pasang panel + tombol "Kirim Pesan Anonim" (default: channel tempat command diketik)
//   !anonim                     → lihat status
//   !anonim buka <nomor>        → buka blokir pengirim pertanyaan #nomor (identitasnya tetap anonim)
//
// Atur izin channel-nya di Discord: @everyone boleh LIHAT channel tapi TIDAK boleh kirim pesan,
// jadi satu-satunya cara bertanya adalah lewat tombol.
//
// Soal anonimitas (jujur): nama/ID pengirim TIDAK ditampilkan ke siapa pun di server dan gak muncul di audit log.
// Bot cuma menyimpan "penanda acak" (hash HMAC dari user ID + kunci rahasia) per pertanyaan, dipakai buat
// membatasi spam dan memblokir pengirim yang melanggar tanpa membuka identitasnya. Orang yang punya akses
// ke server hosting bot + kunci rahasia secara teknis tetap bisa mencocokkannya, jadi ini anonim untuk
// member & admin Discord, bukan anonim mutlak terhadap pemilik/hoster bot.
//
// ENV opsional:
//   ANON_SECRET   kunci rahasia untuk hash (kalau kosong, dibuat acak dan disimpan di anon.json)

const crypto = require('crypto');
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
const FILE = path.join(DATA_DIR, 'anon.json');
const NO_PING = { parse: [], repliedUser: false };

const COOLDOWN_MS = 60 * 1000; // jeda antar pertanyaan per orang
const MAX_PER_HOUR = 5;
const MIN_LEN = 5;
const MAX_QUESTION = 1000;
const MAX_ANSWER = 1000; // batas field embed 1024
const KEEP_QUESTIONS = 1000; // riwayat nomor→penanda yang disimpan
const INVITE_REGEX = /(discord\.gg|discord(?:app)?\.com\/invite)\//i;

const COLOR_OPEN = 0xf1c40f;
const COLOR_DONE = 0x2ecc71;

// ---------- Penyimpanan ----------
// { secret, counter, config: { channelId, panelMessageId }, questions: { [messageId]: { n, h } }, blocked: [h] }
let db = { secret: '', counter: 0, config: null, questions: {}, blocked: [] };
try {
  if (fs.existsSync(FILE)) db = { ...db, ...JSON.parse(fs.readFileSync(FILE, 'utf-8')) };
} catch (err) {
  console.error('[AnonQA] Gagal load anon.json:', err);
}
if (process.env.ANON_SECRET) db.secret = process.env.ANON_SECRET;
if (!db.secret) db.secret = crypto.randomBytes(16).toString('hex');

function save() {
  // pangkas riwayat lama supaya file gak membengkak
  const entries = Object.entries(db.questions);
  if (entries.length > KEEP_QUESTIONS) {
    entries
      .sort((a, b) => a[1].n - b[1].n)
      .slice(0, entries.length - KEEP_QUESTIONS)
      .forEach(([id]) => delete db.questions[id]);
  }
  try {
    fs.writeFileSync(FILE, JSON.stringify(db, null, 2), 'utf-8');
  } catch (err) {
    console.error('[AnonQA] Gagal simpan anon.json:', err);
  }
}
save();

const hashUser = (userId) => crypto.createHmac('sha256', db.secret).update(String(userId)).digest('hex').slice(0, 16);

const isStaff = (member) =>
  !!(
    member?.permissions?.has(PermissionsBitField.Flags.Administrator) ||
    member?.permissions?.has(PermissionsBitField.Flags.ManageMessages)
  );

// ---------- Rate limit (di memori) ----------
const recent = new Map(); // hash -> [timestamp]

function checkRate(h) {
  const now = Date.now();
  const list = (recent.get(h) || []).filter((t) => now - t < 60 * 60 * 1000);
  recent.set(h, list);
  if (list.length && now - list[list.length - 1] < COOLDOWN_MS) {
    return `Tunggu ${Math.ceil((COOLDOWN_MS - (now - list[list.length - 1])) / 1000)} detik dulu sebelum kirim lagi yaa.`;
  }
  if (list.length >= MAX_PER_HOUR) return `Batas ${MAX_PER_HOUR} pesan per jam sudah tercapai. Coba lagi nanti yaa.`;
  return null;
}
const markSent = (h) => recent.set(h, [...(recent.get(h) || []), Date.now()]);

// ---------- Tampilan ----------
function panelPayload() {
  const embed = new EmbedBuilder()
    .setTitle('📮 Tanya Jawab Anonim')
    .setDescription(
      'Mau nanya atau curhat tanpa ketahuan siapa pengirimnya? Klik tombol di bawah, tulis pesanmu, lalu admin akan menjawabnya di channel ini.\n\n' +
        '• Namamu **tidak ditampilkan** ke siapa pun di server.\n' +
        '• Bot hanya menyimpan penanda terenkripsi untuk mencegah spam dan pelanggaran.\n' +
        '• Dilarang spam, link undangan server, dan konten yang melanggar aturan.'
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('anon:ask').setLabel('Kirim Pesan Anonim').setEmoji('✉️').setStyle(ButtonStyle.Primary)
  );
  return { embeds: [embed], components: [row] };
}

function staffRow(answered) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('anon:ans').setLabel(answered ? 'Ubah jawaban' : 'Jawab').setEmoji('💬').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('anon:del').setLabel('Hapus').setEmoji('🗑️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('anon:block').setLabel('Blokir pengirim').setEmoji('🚫').setStyle(ButtonStyle.Danger)
  );
}

function questionEmbed(n, text) {
  return new EmbedBuilder()
    .setTitle(`❓ Pertanyaan Anonim #${n}`)
    .setDescription(text)
    .setColor(COLOR_OPEN)
    .setFooter({ text: 'Belum dijawab' })
    .setTimestamp(new Date());
}

// ---------- Command admin ----------
async function handleCommand(message, content) {
  if (!message.member?.permissions?.has(PermissionsBitField.Flags.Administrator)) {
    await message.reply('Command ini cuma buat Administrator yaa 🙏');
    return;
  }
  const parts = content.trim().split(/\s+/);
  const sub = (parts[1] || '').toLowerCase();

  if (!sub) {
    await message.reply({
      content: db.config
        ? `📮 **Tanya jawab anonim aktif** di <#${db.config.channelId}>\nTotal pertanyaan: **${db.counter}** • Pengirim diblokir: **${new Set(db.blocked).size}**\nPasang ulang: \`!anonim pasang #channel\` • Buka blokir: \`!anonim buka <nomor>\``
        : 'Belum dipasang. Ketik `!anonim pasang #channel` (atau di channel tujuan langsung `!anonim pasang`).',
      allowedMentions: NO_PING,
    });
    return;
  }

  if (sub === 'pasang') {
    const channel = message.mentions.channels?.first() || message.channel;
    let sent;
    try {
      sent = await channel.send(panelPayload());
    } catch (err) {
      await message.reply({ content: `Gagal kirim panel ke <#${channel.id}>. Cek izin bot di channel itu.`, allowedMentions: NO_PING });
      return;
    }
    db.config = { channelId: channel.id, panelMessageId: sent.id };
    save();
    await message.reply({
      content:
        `✅ Panel tanya jawab anonim terpasang di <#${channel.id}>.\n` +
        'Atur izin channelnya di Discord: @everyone boleh **lihat** tapi **tidak boleh kirim pesan**, supaya semua pertanyaan lewat tombol. ' +
        'Bot butuh izin kirim pesan + embed di channel itu.',
      allowedMentions: NO_PING,
    });
    return;
  }

  if (sub === 'buka') {
    const n = parseInt(parts[2], 10);
    const entry = Object.values(db.questions).find((q) => q.n === n);
    if (!entry) {
      await message.reply('Nomor pertanyaan itu gak ketemu di riwayat.');
      return;
    }
    const before = db.blocked.length;
    db.blocked = db.blocked.filter((h) => h !== entry.h);
    save();
    await message.reply(db.blocked.length < before ? `✅ Pengirim pertanyaan #${n} sudah dibuka blokirnya.` : `Pengirim pertanyaan #${n} memang gak lagi diblokir.`);
    return;
  }

  await message.reply('Format: `!anonim` / `!anonim pasang #channel` / `!anonim buka <nomor>`');
}

// ---------- Interaksi ----------
async function handleButton(interaction) {
  const eph = MessageFlags.Ephemeral;
  const id = interaction.customId;

  // Member: buka form
  if (id === 'anon:ask') {
    const h = hashUser(interaction.user.id);
    if (db.blocked.includes(h)) {
      await interaction.reply({ content: 'Kamu gak bisa mengirim pesan anonim saat ini.', flags: eph });
      return;
    }
    const limit = checkRate(h);
    if (limit) {
      await interaction.reply({ content: limit, flags: eph });
      return;
    }
    const modal = new ModalBuilder()
      .setCustomId('anon:askmodal')
      .setTitle('Pesan Anonim')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('text')
            .setLabel('Tulis pertanyaan atau pesanmu')
            .setStyle(TextInputStyle.Paragraph)
            .setMinLength(MIN_LEN)
            .setMaxLength(MAX_QUESTION)
            .setRequired(true)
        )
      );
    await interaction.showModal(modal);
    return;
  }

  // Sisanya khusus staff
  if (!isStaff(interaction.member)) {
    await interaction.reply({ content: 'Tombol ini cuma buat admin.', flags: eph });
    return;
  }
  const msgId = interaction.message.id;

  if (id === 'anon:ans') {
    const modal = new ModalBuilder()
      .setCustomId(`anon:ansmodal:${msgId}`)
      .setTitle('Jawab Pertanyaan')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('jawaban')
            .setLabel('Jawabanmu')
            .setStyle(TextInputStyle.Paragraph)
            .setMinLength(1)
            .setMaxLength(MAX_ANSWER)
            .setRequired(true)
        )
      );
    await interaction.showModal(modal);
    return;
  }

  if (id === 'anon:del') {
    await interaction.message.delete().catch(() => {});
    delete db.questions[msgId];
    save();
    await interaction.reply({ content: '🗑️ Pertanyaan dihapus.', flags: eph });
    return;
  }

  if (id === 'anon:block') {
    const q = db.questions[msgId];
    if (!q) {
      await interaction.reply({ content: 'Data pengirim pertanyaan ini sudah tidak tersimpan, jadi gak bisa diblokir.', flags: eph });
      return;
    }
    if (!db.blocked.includes(q.h)) db.blocked.push(q.h);
    save();
    await interaction.reply({
      content: `🚫 Pengirim pertanyaan #${q.n} diblokir. Identitasnya tetap anonim. Buka blokir dengan \`!anonim buka ${q.n}\`.`,
      flags: eph,
    });
  }
}

async function handleModal(interaction) {
  const eph = MessageFlags.Ephemeral;

  // Member mengirim pertanyaan
  if (interaction.customId === 'anon:askmodal') {
    const h = hashUser(interaction.user.id);
    if (db.blocked.includes(h)) {
      await interaction.reply({ content: 'Kamu gak bisa mengirim pesan anonim saat ini.', flags: eph });
      return;
    }
    const limit = checkRate(h);
    if (limit) {
      await interaction.reply({ content: limit, flags: eph });
      return;
    }
    const text = interaction.fields.getTextInputValue('text').trim();
    if (text.length < MIN_LEN) {
      await interaction.reply({ content: 'Pesannya terlalu pendek.', flags: eph });
      return;
    }
    if (INVITE_REGEX.test(text)) {
      await interaction.reply({ content: 'Link undangan server gak boleh dikirim di sini.', flags: eph });
      return;
    }
    if (!db.config) {
      await interaction.reply({ content: 'Fitur ini belum dipasang admin.', flags: eph });
      return;
    }

    const channel = await interaction.client.channels.fetch(db.config.channelId).catch(() => null);
    if (!channel?.send) {
      await interaction.reply({ content: 'Maaf, channel tujuannya gak bisa diakses bot. Kabari admin yaa.', flags: eph });
      return;
    }

    const n = db.counter + 1;
    let posted;
    try {
      posted = await channel.send({
        embeds: [questionEmbed(n, text)],
        components: [staffRow(false)],
        allowedMentions: NO_PING,
      });
    } catch (err) {
      console.error('[AnonQA] Gagal posting pertanyaan:', err.message);
      await interaction.reply({ content: 'Maaf, gagal mengirim pesanmu. Coba lagi sebentar.', flags: eph });
      return;
    }

    db.counter = n;
    db.questions[posted.id] = { n, h };
    save();
    markSent(h);
    await interaction.reply({ content: `✅ Pesanmu terkirim secara anonim sebagai **#${n}**. Tunggu jawaban admin di <#${db.config.channelId}> yaa.`, flags: eph });
    return;
  }

  // Admin menjawab
  if (interaction.customId.startsWith('anon:ansmodal:')) {
    if (!isStaff(interaction.member)) {
      await interaction.reply({ content: 'Cuma admin yang bisa menjawab.', flags: eph });
      return;
    }
    const msgId = interaction.customId.split(':')[2];
    const answer = interaction.fields.getTextInputValue('jawaban').trim();
    const channel = interaction.channel || (db.config && (await interaction.client.channels.fetch(db.config.channelId).catch(() => null)));
    const msg = await channel?.messages?.fetch(msgId).catch(() => null);
    if (!msg || !msg.embeds?.[0]) {
      await interaction.reply({ content: 'Pesan pertanyaannya gak ketemu (mungkin sudah dihapus).', flags: eph });
      return;
    }

    const adminName = interaction.member?.displayName || interaction.user.username;
    const embed = EmbedBuilder.from(msg.embeds[0]);
    const fields = (embed.data.fields || []).filter((f) => !f.name.startsWith('💬'));
    embed.setFields(...fields, { name: '💬 Jawaban admin', value: answer });
    embed.setColor(COLOR_DONE).setFooter({ text: `Terjawab oleh ${adminName}` });

    await msg.edit({ embeds: [embed], components: [staffRow(true)], allowedMentions: NO_PING });
    await interaction.reply({ content: '✅ Jawabanmu sudah dipasang.', flags: eph });
  }
}

module.exports = function initAnonQA(client) {
  client.on('messageCreate', async (message) => {
    try {
      if (!message.guild || message.author?.bot || message.webhookId) return;
      const content = message.content || '';
      if (!/^!anonim(\s|$)/i.test(content)) return;
      await handleCommand(message, content);
    } catch (err) {
      console.error('[AnonQA] Error command:', err);
    }
  });

  client.on('interactionCreate', async (interaction) => {
    try {
      if (!interaction.guildId) return;
      if (interaction.isButton() && interaction.customId.startsWith('anon:')) await handleButton(interaction);
      else if (interaction.isModalSubmit() && interaction.customId.startsWith('anon:')) await handleModal(interaction);
    } catch (err) {
      console.error('[AnonQA] Error interaksi:', err);
    }
  });
};
