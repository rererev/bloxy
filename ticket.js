// ticket.js — tiket support PRIVAT "tanya apa pun".
//
// Cara kerja: member klik tombol "Buka Tiket" di panel → isi form singkat → Bloxy membuat channel privat
// (cuma member itu + admin/staff yang bisa lihat). Bloxy (FAQ + AI) menjawab dulu; kalau belum beres, member
// klik "Panggil Admin". Admin bisa Claim, lalu Tutup. Saat ditutup, transkrip dikirim ke channel log
// (dan ke DM pemilik tiket kalau DM-nya terbuka), lalu channel dihapus.
//
// Pasang di index.js (sudah diatur lewat sambungan di akhir file):
//   require('./ticket')(client, { answer: async (teks) => 'jawaban' | null });
//
// Command (khusus Administrator):
//   !tiket                         → lihat pengaturan
//   !tiket pasang [#channel]       → pasang panel tombol (default: channel ini)
//   !tiket kategori <ID|#kategori> → kategori tempat channel tiket dibuat
//   !tiket log #channel            → channel log (notifikasi tiket baru + transkrip)
//   !tiket staff @role [@role2]    → role staff yang ikut bisa lihat & dipanggil (Administrator selalu bisa lihat)
//   !tiket ai on|off               → jawaban otomatis Bloxy di dalam tiket
//
// Izin bot: Manage Channels, Manage Roles, View Channel, Send Messages, Embed Links, Attach Files, Read Message History.
//
// ENV opsional (menimpa pengaturan command):
//   TICKET_CATEGORY_ID, TICKET_LOG_CHANNEL_ID, TICKET_STAFF_ROLE_ID (boleh banyak, pisah koma)
//   TICKET_IDLE_HOURS   tutup otomatis setelah sekian jam tanpa aktivitas (default 48)

const fs = require('fs');
const path = require('path');
const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionsBitField,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const DATA_DIR = process.env.DATA_DIR ? process.env.DATA_DIR : __dirname;
const FILE = path.join(DATA_DIR, 'tickets.json');
const NO_PING = { parse: [], repliedUser: false };
const P = PermissionsBitField.Flags;

const csv = (v) => (v || '').split(',').map((x) => x.trim()).filter(Boolean);
const IDLE_MS = (parseInt(process.env.TICKET_IDLE_HOURS, 10) > 0 ? parseInt(process.env.TICKET_IDLE_HOURS, 10) : 48) * 3600 * 1000;
const WARN_BEFORE_MS = 6 * 3600 * 1000;
const SWEEP_MS = 10 * 60 * 1000;
const MAX_AUTO_ANSWERS = 12; // batas jawaban otomatis per tiket
const AI_GAP_MS = 8 * 1000; // jeda minimal antar jawaban otomatis
const CALL_COOLDOWN_MS = 2 * 60 * 1000;
const COLOR_OPEN = 0x5865f2;
const COLOR_CLAIMED = 0x2ecc71;

// ---------- Penyimpanan ----------
let db = { config: { panelChannelId: null, categoryId: null, logChannelId: null, staffRoleIds: [], aiEnabled: true }, counter: 0, tickets: {} };
try {
  if (fs.existsSync(FILE)) {
    const loaded = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
    db = { ...db, ...loaded, config: { ...db.config, ...(loaded.config || {}) } };
  }
} catch (err) {
  console.error('[Tiket] Gagal load tickets.json:', err);
  try {
    if (fs.existsSync(`${FILE}.bak`)) db = { ...db, ...JSON.parse(fs.readFileSync(`${FILE}.bak`, 'utf-8')) };
  } catch (e) {
    /* abaikan */
  }
}

function save() {
  const tmp = `${FILE}.tmp`;
  try {
    if (fs.existsSync(FILE)) {
      try {
        fs.copyFileSync(FILE, `${FILE}.bak`);
      } catch (e) {
        /* opsional */
      }
    }
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf-8');
    fs.renameSync(tmp, FILE);
  } catch (err) {
    console.error('[Tiket] Gagal simpan tickets.json:', err);
  }
}
let saveTimer = null;
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    save();
  }, 30 * 1000);
  if (saveTimer.unref) saveTimer.unref();
}

function cfg() {
  const c = db.config;
  return {
    ...c,
    categoryId: process.env.TICKET_CATEGORY_ID || c.categoryId,
    logChannelId: process.env.TICKET_LOG_CHANNEL_ID || c.logChannelId,
    staffRoleIds: process.env.TICKET_STAFF_ROLE_ID ? csv(process.env.TICKET_STAFF_ROLE_ID) : c.staffRoleIds,
  };
}

const isTicketChannel = (channelId) => !!db.tickets[channelId];

function isStaff(member) {
  if (!member?.permissions) return false;
  if (member.permissions.has(P.Administrator) || member.permissions.has(P.ManageMessages)) return true;
  const roles = cfg().staffRoleIds;
  return roles.some((id) => member.roles?.cache?.has?.(id));
}

const slug = (s) => String(s || 'user').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16) || 'user';
const trunc = (s, n) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

// ---------- Tampilan ----------
function panelPayload() {
  const embed = new EmbedBuilder()
    .setTitle('🎫 Tiket Support')
    .setDescription(
      'Ada pertanyaan atau kendala? Klik tombol di bawah, tulis masalahmu, lalu Bloxy membuatkan ruang **privat** buat kamu.\n\n' +
        '• Bloxy menjawab dulu, dan admin bisa turun tangan kapan saja.\n' +
        '• Cuma kamu dan admin yang bisa melihat tiketnya.\n' +
        '• Tiap orang cuma boleh punya satu tiket aktif.'
    );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket:open').setLabel('Buka Tiket').setEmoji('🎫').setStyle(ButtonStyle.Primary)
  );
  return { embeds: [embed], components: [row] };
}

function ticketRow(claimed) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket:call').setLabel('Panggil Admin').setEmoji('🔔').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('ticket:claim').setLabel(claimed ? 'Sudah di-claim' : 'Claim').setEmoji('🙋').setStyle(ButtonStyle.Success).setDisabled(!!claimed),
    new ButtonBuilder().setCustomId('ticket:close').setLabel('Tutup').setEmoji('🔒').setStyle(ButtonStyle.Danger)
  );
}

function welcomeEmbed(t, claimedBy) {
  return new EmbedBuilder()
    .setTitle(`🎫 Tiket #${t.n}`)
    .setColor(claimedBy ? COLOR_CLAIMED : COLOR_OPEN)
    .setDescription(`**Subjek:** ${t.subject}\n\n${t.question}`)
    .addFields({
      name: 'Status',
      value: claimedBy ? `🙋 Ditangani oleh <@${claimedBy}>` : '⏳ Bloxy menjawab dulu. Klik **Panggil Admin** kalau butuh bantuan langsung.',
    })
    .setFooter({ text: `Tiket ditutup otomatis setelah ${Math.round(IDLE_MS / 3600000)} jam tanpa aktivitas.` });
}

async function sendLog(guild, payload) {
  const id = cfg().logChannelId;
  if (!id) return false;
  const ch = await guild.channels.fetch(id).catch(() => null);
  if (!ch?.send) return false;
  await ch.send(payload).catch((e) => console.error('[Tiket] Gagal kirim log:', e.message));
  return true;
}

// ---------- Transkrip & penutupan ----------
async function collectHistory(channel, limit = 1000) {
  const all = [];
  let before;
  while (all.length < limit) {
    const batch = await channel.messages.fetch(before ? { limit: 100, before } : { limit: 100 });
    if (!batch.size) break;
    all.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  return all.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

function buildTranscript(t, messages) {
  const fmt = (ts) => new Date(ts).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false });
  const lines = [`Transkrip Tiket #${t.n}`, `Subjek: ${t.subject}`, `Dibuka: ${fmt(t.createdAt)} WIB`, `Pemilik: ${t.userTag || t.userId}`, '='.repeat(40)];
  for (const m of messages) {
    const who = m.member?.displayName || m.author?.username || 'unknown';
    const body = (m.content || '').replace(/\n/g, '\n    ');
    const extra = [...(m.attachments?.values?.() || [])].map((a) => `    [lampiran] ${a.url}`).join('\n');
    const emb = (m.embeds || []).map((e) => `    [embed] ${e.title || ''} ${e.description ? `— ${String(e.description).slice(0, 200).replace(/\n/g, ' ')}` : ''}`.trimEnd()).join('\n');
    lines.push(`[${fmt(m.createdTimestamp)}] ${who}${m.author?.bot ? ' (bot)' : ''}: ${body}`.trimEnd());
    if (extra) lines.push(extra);
    if (emb) lines.push(emb);
  }
  return lines.join('\n');
}

async function closeTicket(channel, t, closedBy, reason) {
  delete db.tickets[channel.id];
  save();

  let history = [];
  try {
    history = await collectHistory(channel);
  } catch (err) {
    console.error('[Tiket] Gagal ambil riwayat buat transkrip:', err.message);
  }
  const text = buildTranscript(t, history);
  const fileName = `transkrip-tiket-${String(t.n).padStart(4, '0')}.txt`;
  const makeFile = () => new AttachmentBuilder(Buffer.from(text, 'utf-8'), { name: fileName });

  const mins = Math.max(1, Math.round((Date.now() - t.createdAt) / 60000));
  const embed = new EmbedBuilder()
    .setTitle(`🔒 Tiket #${t.n} ditutup`)
    .setColor(0xe74c3c)
    .addFields(
      { name: 'Pemilik', value: `<@${t.userId}>`, inline: true },
      { name: 'Ditutup oleh', value: closedBy, inline: true },
      { name: 'Subjek', value: trunc(t.subject, 200) },
      { name: 'Ringkas', value: `${history.length} pesan • ${mins} menit${t.claimedBy ? ` • ditangani <@${t.claimedBy}>` : ''}${reason ? ` • ${reason}` : ''}` }
    );
  const logged = await sendLog(channel.guild, { embeds: [embed], files: [makeFile()], allowedMentions: NO_PING });

  // Salinan ke DM pemilik tiket (kalau DM-nya terbuka)
  try {
    const owner = await channel.client.users.fetch(t.userId);
    await owner.send({ content: `Tiket support #${t.n} kamu sudah ditutup. Ini salinan percakapannya.`, files: [makeFile()] });
  } catch (e) {
    /* DM tertutup: abaikan */
  }

  await channel.send({ content: `🔒 Tiket ditutup oleh ${closedBy}${reason ? ` (${reason})` : ''}. Channel ini dihapus dalam 5 detik.${logged ? '' : '\n⚠️ Channel log belum diatur, jadi transkrip tidak tersimpan di server.'}`, allowedMentions: NO_PING }).catch(() => {});
  const timer = setTimeout(() => channel.delete(`Tiket #${t.n} ditutup`).catch((e) => console.error('[Tiket] Gagal hapus channel:', e.message)), 5000);
  if (timer.unref) timer.unref();
}

// ---------- Command admin ----------
async function handleCommand(message, content) {
  if (!message.member?.permissions?.has(P.Administrator)) {
    await message.reply('Command ini cuma buat Administrator yaa 🙏');
    return;
  }
  const parts = content.trim().split(/\s+/);
  const sub = (parts[1] || '').toLowerCase();
  const c = cfg();

  if (!sub) {
    const staff = c.staffRoleIds.length ? c.staffRoleIds.map((id) => `<@&${id}>`).join(' ') : '_belum ada (hanya Administrator)_';
    await message.reply({
      content:
        `🎫 **Tiket support**\n` +
        `Panel: ${c.panelChannelId ? `<#${c.panelChannelId}>` : '_belum dipasang_'}\n` +
        `Kategori: ${c.categoryId ? `<#${c.categoryId}>` : '_belum diatur (channel dibuat di luar kategori)_'}\n` +
        `Channel log: ${c.logChannelId ? `<#${c.logChannelId}>` : '_belum diatur (transkrip tidak tersimpan di server!)_'}\n` +
        `Staff: ${staff}\nJawaban otomatis Bloxy: **${c.aiEnabled ? 'on' : 'off'}** • Tiket aktif: **${Object.keys(db.tickets).length}**\n\n` +
        'Atur: `!tiket pasang #channel` • `!tiket kategori <id>` • `!tiket log #channel` • `!tiket staff @role` • `!tiket ai on|off`',
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
    db.config.panelChannelId = channel.id;
    db.config.panelMessageId = sent.id;
    save();
    await message.reply({
      content:
        `✅ Panel tiket terpasang di <#${channel.id}>.\n` +
        'Langkah berikutnya: `!tiket kategori <id>` (biar rapi), `!tiket log #channel` (biar transkrip tersimpan), dan `!tiket staff @role` (kalau ada mod selain Administrator).',
      allowedMentions: NO_PING,
    });
    return;
  }

  if (sub === 'kategori') {
    const arg = parts[2] || '';
    const id = (arg.match(/\d{15,}/) || [])[0];
    const cat = id && message.guild.channels.cache.get(id);
    if (!cat || cat.type !== ChannelType.GuildCategory) {
      await message.reply('Format: `!tiket kategori <ID kategori>` — klik kanan kategori → Copy Channel ID (mode Developer harus aktif).');
      return;
    }
    db.config.categoryId = id;
    save();
    await message.reply(`✅ Tiket baru akan dibuat di kategori **${cat.name}**.`);
    return;
  }

  if (sub === 'log') {
    const ch = message.mentions.channels?.first();
    if (!ch) {
      await message.reply('Format: `!tiket log #channel`');
      return;
    }
    db.config.logChannelId = ch.id;
    save();
    await message.reply({ content: `✅ Notifikasi tiket dan transkrip dikirim ke <#${ch.id}>.`, allowedMentions: NO_PING });
    return;
  }

  if (sub === 'staff') {
    const roles = [...(message.mentions.roles?.values?.() || [])];
    if (!roles.length) {
      await message.reply('Format: `!tiket staff @role` (boleh lebih dari satu). Administrator selalu bisa melihat semua tiket.');
      return;
    }
    db.config.staffRoleIds = roles.map((r) => r.id);
    save();
    await message.reply({ content: `✅ Staff tiket: ${roles.map((r) => `<@&${r.id}>`).join(' ')}`, allowedMentions: NO_PING });
    return;
  }

  if (sub === 'ai') {
    const v = (parts[2] || '').toLowerCase();
    if (!['on', 'off'].includes(v)) {
      await message.reply('Format: `!tiket ai on` atau `!tiket ai off`');
      return;
    }
    db.config.aiEnabled = v === 'on';
    save();
    await message.reply(`✅ Jawaban otomatis Bloxy di dalam tiket: **${v}**.`);
    return;
  }

  await message.reply('Format: `!tiket` / `!tiket pasang #channel` / `!tiket kategori <id>` / `!tiket log #channel` / `!tiket staff @role` / `!tiket ai on|off`');
}

// ---------- Interaksi ----------
const lastAi = new Map(); // channelId -> timestamp

function findOpenTicketOf(guild, userId) {
  for (const [channelId, t] of Object.entries(db.tickets)) {
    if (t.userId !== userId) continue;
    if (guild.channels.cache.has(channelId)) return { channelId, t };
    delete db.tickets[channelId]; // channelnya sudah hilang
    saveSoon();
  }
  return null;
}

async function autoAnswer(channel, t, text, answerFn, { first = false } = {}) {
  if (!answerFn || !cfg().aiEnabled || t.claimedBy || t.staffSeen || (t.aiCount || 0) >= MAX_AUTO_ANSWERS) return;
  const now = Date.now();
  if (!first && now - (lastAi.get(channel.id) || 0) < AI_GAP_MS) return;
  lastAi.set(channel.id, now);

  await channel.sendTyping?.().catch(() => {});
  let reply = null;
  try {
    reply = await answerFn(text);
  } catch (err) {
    console.error('[Tiket] Jawaban otomatis gagal:', err.message);
  }
  if (!reply) {
    if (first) await channel.send('Pertanyaanmu sudah kucatat 📝 Admin akan membalas secepatnya. Kalau mendesak, klik **Panggil Admin** di atas.').catch(() => {});
    return;
  }
  t.aiCount = (t.aiCount || 0) + 1;
  saveSoon();
  await channel
    .send({ content: `${trunc(reply, 1850)}\n\n-# 🤖 Jawaban otomatis dari Bloxy. Kalau belum membantu, klik **Panggil Admin**.`, allowedMentions: NO_PING })
    .catch(() => {});
}

async function handleOpen(interaction) {
  const eph = MessageFlags.Ephemeral;
  const existing = findOpenTicketOf(interaction.guild, interaction.user.id);
  if (existing) {
    await interaction.reply({ content: `Kamu masih punya tiket yang kebuka: <#${existing.channelId}>`, flags: eph });
    return;
  }
  const modal = new ModalBuilder()
    .setCustomId('ticket:openmodal')
    .setTitle('Buka Tiket Support')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('subject').setLabel('Subjek singkat').setStyle(TextInputStyle.Short).setMinLength(3).setMaxLength(80).setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('question').setLabel('Ceritakan pertanyaan / masalahmu').setStyle(TextInputStyle.Paragraph).setMinLength(5).setMaxLength(1000).setRequired(true)
      )
    );
  await interaction.showModal(modal);
}

async function handleOpenModal(interaction, answerFn) {
  const eph = MessageFlags.Ephemeral;
  const guild = interaction.guild;
  const me = guild.members.me;

  const existing = findOpenTicketOf(guild, interaction.user.id);
  if (existing) {
    await interaction.reply({ content: `Kamu masih punya tiket yang kebuka: <#${existing.channelId}>`, flags: eph });
    return;
  }
  if (!me?.permissions.has(P.ManageChannels) || !me?.permissions.has(P.ManageRoles)) {
    await interaction.reply({ content: 'Maaf, bot belum punya izin **Manage Channels** dan **Manage Roles** buat membuat tiket. Kabari admin yaa.', flags: eph });
    return;
  }

  const subject = interaction.fields.getTextInputValue('subject').trim();
  const question = interaction.fields.getTextInputValue('question').trim();
  await interaction.deferReply({ flags: eph });

  const c = cfg();
  const n = db.counter + 1;
  const staffRoles = c.staffRoleIds.filter((id) => guild.roles.cache.has(id));
  const memberAllow = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AttachFiles, P.EmbedLinks];
  const parent = c.categoryId && guild.channels.cache.get(c.categoryId)?.type === ChannelType.GuildCategory ? c.categoryId : undefined;

  let channel;
  try {
    channel = await guild.channels.create({
      name: `tiket-${String(n).padStart(4, '0')}-${slug(interaction.user.username)}`,
      type: ChannelType.GuildText,
      parent,
      topic: `Tiket #${n} • ${interaction.user.tag || interaction.user.username}`,
      permissionOverwrites: [
        { id: guild.id, deny: [P.ViewChannel] },
        { id: interaction.user.id, allow: memberAllow },
        { id: me.id, allow: [...memberAllow, P.ManageChannels] },
        ...staffRoles.map((id) => ({ id, allow: memberAllow })),
      ],
      reason: `Tiket support #${n}`,
    });
  } catch (err) {
    console.error('[Tiket] Gagal membuat channel:', err.message);
    await interaction.editReply('Maaf, gagal membuat tiketmu. Kabari admin yaa 🙏');
    return;
  }

  const t = {
    n,
    guildId: guild.id,
    userId: interaction.user.id,
    userTag: interaction.user.tag || interaction.user.username,
    subject,
    question,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    claimedBy: null,
    aiCount: 0,
    staffSeen: false,
    warned: false,
    lastCall: 0,
  };
  db.counter = n;
  db.tickets[channel.id] = t;
  save();

  await channel.send({
    content: `<@${interaction.user.id}>`,
    embeds: [welcomeEmbed(t, null)],
    components: [ticketRow(false)],
    allowedMentions: { users: [interaction.user.id] },
  });
  await interaction.editReply(`✅ Tiketmu sudah dibuat: <#${channel.id}>`);

  await sendLog(guild, {
    content: staffRoles.length ? `🆕 ${staffRoles.map((r) => `<@&${r}>`).join(' ')}` : '🆕',
    embeds: [new EmbedBuilder().setTitle(`🆕 Tiket #${n} dibuka`).setColor(COLOR_OPEN).setDescription(`<#${channel.id}> • oleh <@${interaction.user.id}>\n**${trunc(subject, 200)}**`)],
    allowedMentions: { roles: staffRoles },
  });

  await autoAnswer(channel, t, `${subject}\n${question}`, answerFn, { first: true });
}

async function handleButton(interaction) {
  const eph = MessageFlags.Ephemeral;
  const id = interaction.customId;
  const t = db.tickets[interaction.channel?.id];
  if (!t) {
    await interaction.reply({ content: 'Tiket ini sudah gak aktif.', flags: eph });
    return;
  }
  const staff = isStaff(interaction.member);
  const owner = interaction.user.id === t.userId;

  if (id === 'ticket:call') {
    if (!owner && !staff) {
      await interaction.reply({ content: 'Tombol ini cuma buat pemilik tiket.', flags: eph });
      return;
    }
    const wait = t.lastCall + CALL_COOLDOWN_MS - Date.now();
    if (wait > 0) {
      await interaction.reply({ content: `Admin sudah dipanggil barusan. Tunggu ${Math.ceil(wait / 1000)} detik kalau mau memanggil lagi.`, flags: eph });
      return;
    }
    t.lastCall = Date.now();
    save();
    const roles = cfg().staffRoleIds;
    await interaction.reply({
      content: roles.length ? `🔔 ${roles.map((r) => `<@&${r}>`).join(' ')} — <@${t.userId}> butuh bantuan di tiket ini.` : `🔔 Permintaanmu sudah diteruskan ke admin lewat channel log. Mohon tunggu yaa.`,
      allowedMentions: { roles },
    });
    await sendLog(interaction.guild, { content: `🔔 Tiket #${t.n} butuh admin: <#${interaction.channel.id}>`, allowedMentions: { roles: [] } });
    return;
  }

  if (id === 'ticket:claim') {
    if (!staff) {
      await interaction.reply({ content: 'Cuma admin/staff yang bisa meng-claim tiket.', flags: eph });
      return;
    }
    t.claimedBy = interaction.user.id;
    t.staffSeen = true;
    save();
    await interaction.update({ embeds: [welcomeEmbed(t, interaction.user.id)], components: [ticketRow(true)] });
    await interaction.channel.send({ content: `🙋 <@${interaction.user.id}> akan membantu kamu, <@${t.userId}>.`, allowedMentions: { users: [t.userId, interaction.user.id] } });
    return;
  }

  if (id === 'ticket:close') {
    if (!owner && !staff) {
      await interaction.reply({ content: 'Cuma pemilik tiket atau admin yang bisa menutupnya.', flags: eph });
      return;
    }
    await interaction.reply({
      content: 'Yakin mau menutup tiket ini? Channel akan dihapus dan transkripnya disimpan.',
      components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ticket:closeyes').setLabel('Ya, tutup tiket').setStyle(ButtonStyle.Danger))],
      flags: eph,
    });
    return;
  }

  if (id === 'ticket:closeyes') {
    if (!owner && !staff) {
      await interaction.reply({ content: 'Cuma pemilik tiket atau admin yang bisa menutupnya.', flags: eph });
      return;
    }
    await interaction.update({ content: '🔒 Menutup tiket...', components: [] });
    await closeTicket(interaction.channel, t, interaction.member?.displayName || interaction.user.username, owner && !staff ? 'ditutup pemilik' : '');
  }
}

module.exports = function initTicket(client, options = {}) {
  const answerFn = options.answer;

  client.on('messageCreate', async (message) => {
    try {
      if (!message.guild || message.author?.bot || message.webhookId) return;
      const content = message.content || '';
      const t = db.tickets[message.channel.id];

      if (!t) {
        if (/^!tiket(\s|$)/i.test(content)) await handleCommand(message, content);
        return;
      }

      t.lastActivity = Date.now();
      t.warned = false;
      saveSoon();

      const owner = message.author.id === t.userId;
      if (!owner && isStaff(message.member)) {
        t.staffSeen = true; // admin sudah turun tangan → Bloxy berhenti menjawab otomatis
        return;
      }
      if (owner && content.trim()) await autoAnswer(message.channel, t, content, answerFn);
    } catch (err) {
      console.error('[Tiket] Error pesan:', err);
    }
  });

  client.on('interactionCreate', async (interaction) => {
    try {
      if (!interaction.guildId || !interaction.customId?.startsWith('ticket:')) return;
      if (interaction.isButton()) {
        if (interaction.customId === 'ticket:open') await handleOpen(interaction);
        else await handleButton(interaction);
      } else if (interaction.isModalSubmit() && interaction.customId === 'ticket:openmodal') {
        await handleOpenModal(interaction, answerFn);
      }
    } catch (err) {
      console.error('[Tiket] Error interaksi:', err);
    }
  });

  client.on('channelDelete', (channel) => {
    if (db.tickets[channel.id]) {
      delete db.tickets[channel.id];
      save();
    }
  });

  // Sapuan: peringatan lalu tutup otomatis tiket yang lama tidak ada aktivitas
  const sweep = setInterval(async () => {
    if (!client.isReady?.()) return;
    const now = Date.now();
    for (const [channelId, t] of Object.entries(db.tickets)) {
      try {
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel) {
          delete db.tickets[channelId];
          save();
          continue;
        }
        const idle = now - t.lastActivity;
        if (idle >= IDLE_MS) await closeTicket(channel, t, 'sistem', 'tidak ada aktivitas');
        else if (idle >= IDLE_MS - WARN_BEFORE_MS && !t.warned) {
          t.warned = true;
          saveSoon();
          await channel.send({ content: `⏳ <@${t.userId}> tiket ini bakal ditutup otomatis dalam sekitar ${Math.round(WARN_BEFORE_MS / 3600000)} jam kalau tidak ada balasan.`, allowedMentions: { users: [t.userId] } }).catch(() => {});
        }
      } catch (err) {
        console.error('[Tiket] Error sapuan:', err.message);
      }
    }
  }, SWEEP_MS);
  if (sweep.unref) sweep.unref();
};

module.exports.isTicketChannel = isTicketChannel;
