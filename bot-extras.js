// bot-extras.js — fitur tambahan Bloxy:
//   !help                      → daftar semua command
//   !dmjam [hari] [HH:MM]      → lihat / ubah jadwal DM otomatis (!dm)
//   !war boss [keterangan]     → buka pendaftaran war boss; member ketik "ikut"
//   !warlist / !warhapus / !warselesai
//   (!poll pindah ke poll.js)

const fs = require('fs');
const path = require('path');
const { EmbedBuilder, PermissionsBitField } = require('discord.js');

const DATA_DIR = process.env.DATA_DIR ? process.env.DATA_DIR : __dirname;
const NO_PING = { parse: [], repliedUser: false };

function isAdmin(message) {
  return message.member?.permissions?.has(PermissionsBitField.Flags.Administrator) ?? false;
}

function loadJson(file, fallback) {
  try {
    const p = path.join(DATA_DIR, file);
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (err) {
    console.error(`[bot-extras] Gagal load ${file}:`, err);
    return fallback;
  }
}

function saveJson(file, data) {
  try {
    fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error(`[bot-extras] Gagal simpan ${file}:`, err);
    return false;
  }
}

// ====================================================================
// 1. JADWAL DM OTOMATIS (!dm) — bisa diubah lewat !dmjam, tanpa redeploy
// ====================================================================

const DAYS = [
  { names: ['senin'], weekday: 'Mon', label: 'Senin' },
  { names: ['selasa'], weekday: 'Tue', label: 'Selasa' },
  { names: ['rabu'], weekday: 'Wed', label: 'Rabu' },
  { names: ['kamis'], weekday: 'Thu', label: 'Kamis' },
  { names: ['jumat', "jum'at", 'jumaat'], weekday: 'Fri', label: "Jum'at" },
  { names: ['sabtu'], weekday: 'Sat', label: 'Sabtu' },
  { names: ['minggu', 'ahad'], weekday: 'Sun', label: 'Minggu' },
];

const DM_FILE = 'dm-settings.json';
const DEFAULT_DM = { weekday: 'Sun', hour: 8, minute: 0 }; // sama seperti sebelumnya: Minggu 08:00 WIB
let dmSchedule = { ...DEFAULT_DM, ...loadJson(DM_FILE, {}) };

function getDmSchedule() {
  return dmSchedule;
}

function describeDmSchedule() {
  const day = DAYS.find((d) => d.weekday === dmSchedule.weekday)?.label || 'Minggu';
  const hh = String(dmSchedule.hour).padStart(2, '0');
  const mm = String(dmSchedule.minute).padStart(2, '0');
  return `hari ${day} jam ${hh}.${mm} WIB`;
}

async function handleDmTimeCommand(message, content) {
  const args = content.split(/\s+/).slice(1);

  if (args.length === 0) {
    await message.reply({
      content: `Jadwal DM otomatis sekarang: **${describeDmSchedule()}**.\nUbah dengan \`!dmjam <hari> <HH:MM>\` — contoh: \`!dmjam sabtu 19:30\``,
      allowedMentions: NO_PING,
    });
    return;
  }

  if (!isAdmin(message)) {
    await message.reply('Command ini cuma buat Administrator yaa 🙏');
    return;
  }

  const dayInput = (args[0] || '').toLowerCase();
  const timeMatch = (args[1] || '').match(/^(\d{1,2})[:.](\d{2})$/);
  const day = DAYS.find((d) => d.names.includes(dayInput));

  if (!day || !timeMatch) {
    await message.reply('Format: `!dmjam <hari> <HH:MM>` — contoh: `!dmjam minggu 08:00` (jam WIB, hari: senin–minggu).');
    return;
  }

  const hour = parseInt(timeMatch[1], 10);
  const minute = parseInt(timeMatch[2], 10);
  if (hour > 23 || minute > 59) {
    await message.reply('Jamnya gak valid. Pakai format 24 jam, misal `19:30`.');
    return;
  }

  dmSchedule = { weekday: day.weekday, hour, minute };
  saveJson(DM_FILE, dmSchedule);
  await message.reply(`✅ Jadwal DM otomatis diubah jadi **${describeDmSchedule()}**.`);
}

// ====================================================================
// 2. WAR BOSS — admin buka pendaftaran, member ketik "ikut"
// ====================================================================

const WAR_FILE = 'war-data.json';
// { [channelId]: { open, title, openedBy, openedAt, members: [{ userId, username, joinedAt }] } }
const WAR_SERVER_SIZE = Math.max(1, parseInt(process.env.WAR_SERVER_SIZE || '15', 10) || 15);
let warState = loadJson(WAR_FILE, {});

// Tiap peserta menyimpan nomor SLOT-nya sendiri (field `server` di data), jadi bisa dipindah manual dan
// tidak ikut bergeser slot kalau ada peserta lain yang dihapus. Data lama dibagi urut per WAR_SERVER_SIZE orang.
function assignMissingServers(war) {
  war.members.forEach((m, i) => {
    if (!m.server) m.server = Math.floor(i / WAR_SERVER_SIZE) + 1;
  });
}
for (const war of Object.values(warState)) assignMissingServers(war);

const serverCount = (war, server) => war.members.filter((m) => m.server === server).length;

function nextFreeServer(war) {
  for (let s = 1; ; s++) {
    if (serverCount(war, s) < WAR_SERVER_SIZE) return s;
  }
}
const saveWar = () => saveJson(WAR_FILE, warState);

// Nomor peserta DI DALAM slotnya (1..WAR_SERVER_SIZE), urut sesuai pendaftaran.
function slotNumber(war, idx) {
  const slot = war.members[idx].server;
  let n = 0;
  for (let i = 0; i <= idx; i++) if (war.members[i].server === slot) n++;
  return n;
}

// Referensi peserta: "1-5" (atau "1.5" / "1:5") = Slot 1 nomor 5 → index di war.members, atau -1.
const SLOT_REF = /^(\d+)\s*[-.:]\s*(\d+)$/;

const JOIN_REGEX = /^\s*ikut\b/i;
const LEAVE_REGEX = /^\s*batal\b/i;

async function handleWarBossCommand(message, content) {
  if (!isAdmin(message)) {
    await message.reply('Command ini cuma buat Administrator yaa 🙏');
    return;
  }

  const existing = warState[message.channel.id];
  if (existing?.open) {
    await message.reply('Di channel ini pendaftaran war boss masih kebuka. Tutup dulu pakai `!warselesai`, atau liat daftarnya pakai `!warlist`.');
    return;
  }

  const title = content.replace(/^!war\s*boss\s*/i, '').trim();
  warState[message.channel.id] = {
    open: true,
    title,
    openedBy: message.author.tag,
    openedAt: new Date().toISOString(),
    members: [],
  };
  saveWar();

  const embed = new EmbedBuilder()
    .setTitle('⚔️ WAR BOSS DIBUKA!')
    .setDescription(
      [
        title ? `**${title}**\n` : '',
        'Yang mau ikut, ketik **ikut** di channel ini.',
        'Kalau gak jadi, ketik **batal**.',
      ]
        .filter(Boolean)
        .join('\n')
    )
    .setFooter({ text: 'Admin: !warlist • !warhapus <slot-nomor|@user|semua> • !warselesai' });

  await message.channel.send({ embeds: [embed] });
}

// Dipanggil untuk SEMUA pesan non-bot. Return true kalau pesan ini "ikut"/"batal" di channel war yang kebuka.
async function handleWarJoin(message) {
  const war = warState[message.channel.id];
  if (!war?.open) return false;

  const text = message.content || '';
  const isJoin = JOIN_REGEX.test(text);
  const isLeave = LEAVE_REGEX.test(text);
  if (!isJoin && !isLeave) return false;

  const userId = message.author.id;
  const idx = war.members.findIndex((m) => m.userId === userId);
  const name = message.member?.displayName || message.author.username;

  if (isJoin) {
    if (idx !== -1) {
      await message.reply({ content: `${name}, kamu udah kecatat di Slot ${war.members[idx].server} nomor ${slotNumber(war, idx)} 👍`, allowedMentions: NO_PING });
      return true;
    }
    war.members.push({ userId, username: name, server: nextFreeServer(war), joinedAt: new Date().toISOString() });
    saveWar();
    const reacted = await message.react('✅').then(() => true).catch(() => false);
    if (!reacted) {
      await message.reply({ content: `✅ ${name} kecatat (Slot ${war.members[war.members.length - 1].server} nomor ${slotNumber(war, war.members.length - 1)}).`, allowedMentions: NO_PING });
    }
    return true;
  }

  // batal
  if (idx === -1) return false; // belum terdaftar, biarkan pesan diproses seperti biasa
  war.members.splice(idx, 1);
  saveWar();
  await message.react('👋').catch(() => {});
  return true;
}

// Daftar ditampilkan per SLOT. Nomor = nomor urut di dalam slot (Slot 1: 1–20, Slot 2: 1–20, dst).
// Perintah admin pakai format <slot>-<nomor>, misalnya "1-5" = Slot 1 nomor 5.
function formatWarList(war) {
  if (!war.members.length) return '_Belum ada yang ikut._';
  const groups = new Map();
  war.members.forEach((m) => {
    const s = m.server || 1;
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s).push(m);
  });
  return [...groups.keys()]
    .sort((a, b) => a - b)
    .map((s) => {
      const members = groups.get(s);
      const full = members.length >= WAR_SERVER_SIZE ? ' ✅ penuh' : '';
      const lines = members.map((m, i) => `${i + 1}. ${m.username} — <@${m.userId}> (\`${m.userId}\`)`);
      return `**Slot ${s}** (${members.length}/${WAR_SERVER_SIZE}${full})\n${lines.join('\n')}`;
    })
    .join('\n\n');
}

async function sendLong(message, header, body) {
  const full = `${header}\n${body}`;
  if (full.length <= 1900) {
    await message.reply({ content: full, allowedMentions: NO_PING });
    return;
  }
  const lines = body.split('\n');
  let chunk = header;
  for (const line of lines) {
    if (chunk.length + line.length + 1 > 1900) {
      await message.channel.send({ content: chunk, allowedMentions: NO_PING });
      chunk = '';
    }
    chunk += `${chunk ? '\n' : ''}${line}`;
  }
  if (chunk) await message.channel.send({ content: chunk, allowedMentions: NO_PING });
}

async function handleWarListCommand(message) {
  const war = warState[message.channel.id];
  if (!war) {
    await message.reply('Belum ada war boss di channel ini. Admin bisa buka pakai `!war boss`.');
    return;
  }
  const status = war.open ? 'pendaftaran **kebuka**' : 'pendaftaran **ditutup**';
  const header = `⚔️ **Daftar peserta war boss** (${war.members.length} orang, ${status})${war.title ? `\n_${war.title}_` : ''}`;
  await sendLong(message, header, formatWarList(war));
}

async function handleWarRemoveCommand(message, content) {
  if (!isAdmin(message)) {
    await message.reply('Command ini cuma buat Administrator yaa 🙏');
    return;
  }
  const war = warState[message.channel.id];
  if (!war) {
    await message.reply('Belum ada war boss di channel ini.');
    return;
  }

  const arg = content.split(/\s+/)[1] || '';
  const mentioned = message.mentions.users?.first();

  if (arg.toLowerCase() === 'semua') {
    const n = war.members.length;
    war.members = [];
    saveWar();
    await message.reply(`🗑️ ${n} peserta dihapus. Daftar sekarang kosong.`);
    return;
  }

  let removed = null;
  if (mentioned) {
    const i = war.members.findIndex((m) => m.userId === mentioned.id);
    if (i !== -1) [removed] = war.members.splice(i, 1);
  } else if (SLOT_REF.test(arg)) {
    const i = findMember(war, arg, null);
    if (i !== -1) [removed] = war.members.splice(i, 1);
  } else {
    await message.reply('Format: `!warhapus <slot-nomor>` (contoh `1-5` = Slot 1 nomor 5) / `!warhapus @user` / `!warhapus semua`');
    return;
  }

  if (!removed) {
    await message.reply('Peserta itu gak ketemu di daftar. Cek nomornya pakai `!warlist`.');
    return;
  }
  saveWar();
  await message.reply({ content: `🗑️ ${removed.username} dihapus dari daftar (sisa ${war.members.length} orang).`, allowedMentions: NO_PING });
}

function findMember(war, token, mentioned) {
  if (mentioned) return war.members.findIndex((m) => m.userId === mentioned.id);
  const ref = (token || '').match(SLOT_REF);
  if (!ref) return -1;
  const slot = parseInt(ref[1], 10);
  const nth = parseInt(ref[2], 10);
  let seen = 0;
  for (let i = 0; i < war.members.length; i++) {
    if (war.members[i].server === slot && ++seen === nth) return i;
  }
  return -1;
}

// !warpindah <slot-nomor|@user> <slot>
async function handleWarMoveCommand(message, content) {
  if (!isAdmin(message)) {
    await message.reply('Command ini cuma buat Administrator yaa 🙏');
    return;
  }
  const war = warState[message.channel.id];
  if (!war) {
    await message.reply('Belum ada war boss di channel ini.');
    return;
  }

  const mentioned = message.mentions.users?.first();
  const args = content.split(/\s+/).slice(1).filter((a) => !/^<@!?\d+>$/.test(a));
  const target = mentioned ? args[0] : args[1];
  const who = mentioned ? null : args[0];
  const server = /^\d+$/.test(target || '') ? parseInt(target, 10) : 0;

  if (server < 1 || server > 99) {
    await message.reply('Format: `!warpindah <slot-nomor> <slot>` atau `!warpindah @user <slot>` — contoh: `!warpindah 1-5 2` (peserta Slot 1 nomor 5 dipindah ke Slot 2)');
    return;
  }

  const idx = findMember(war, who, mentioned);
  if (idx === -1) {
    await message.reply('Peserta itu gak ketemu. Cek nomornya pakai `!warlist`.');
    return;
  }

  const m = war.members[idx];
  if (m.server === server) {
    await message.reply({ content: `${m.username} udah ada di Slot ${server}.`, allowedMentions: NO_PING });
    return;
  }
  if (serverCount(war, server) >= WAR_SERVER_SIZE) {
    await message.reply(`Slot ${server} udah penuh (${WAR_SERVER_SIZE}/${WAR_SERVER_SIZE}). Pakai \`!wartukar <slot-nomor> <slot-nomor>\` buat nuker posisi dua peserta, atau pindahin salah satu peserta slot itu dulu.`);
    return;
  }

  const from = m.server;
  m.server = server;
  saveWar();
  await message.reply({ content: `✅ ${m.username} dipindah dari Slot ${from} ke Slot ${server}.`, allowedMentions: NO_PING });
}

// !wartukar <slot-nomor> <slot-nomor> — tukar slot dua peserta (berguna kalau dua-duanya sudah penuh)
async function handleWarSwapCommand(message, content) {
  if (!isAdmin(message)) {
    await message.reply('Command ini cuma buat Administrator yaa 🙏');
    return;
  }
  const war = warState[message.channel.id];
  if (!war) {
    await message.reply('Belum ada war boss di channel ini.');
    return;
  }

  const [a, b] = content.split(/\s+/).slice(1);
  const ia = findMember(war, a, null);
  const ib = findMember(war, b, null);
  if (ia === -1 || ib === -1 || ia === ib) {
    await message.reply('Format: `!wartukar <slot-nomor> <slot-nomor>` — contoh: `!wartukar 1-3 2-7`. Cek nomornya pakai `!warlist`.');
    return;
  }

  const ma = war.members[ia];
  const mb = war.members[ib];
  [ma.server, mb.server] = [mb.server, ma.server];
  saveWar();
  await message.reply({
    content: `🔁 ${ma.username} → Slot ${ma.server}, ${mb.username} → Slot ${mb.server}.`,
    allowedMentions: NO_PING,
  });
}

async function handleWarCloseCommand(message) {
  if (!isAdmin(message)) {
    await message.reply('Command ini cuma buat Administrator yaa 🙏');
    return;
  }
  const war = warState[message.channel.id];
  if (!war?.open) {
    await message.reply('Gak ada pendaftaran war boss yang lagi kebuka di channel ini.');
    return;
  }
  war.open = false;
  saveWar();
  await sendLong(
    message,
    `🔒 **Pendaftaran war boss ditutup.** Total peserta: **${war.members.length}**`,
    formatWarList(war)
  );
}

// (!poll sekarang ada di poll.js — voting pakai tombol, 1 orang 1 suara)

// ====================================================================
// 4. !help
// ====================================================================

async function handleHelpCommand(message) {
  const embed = new EmbedBuilder()
    .setTitle('📖 Daftar Command Bloxy')
    .addFields(
      {
        name: '👥 Semua member',
        value: [
          '`!help` — tampilkan daftar ini',
          '`ikut` / `batal` — daftar / batal ikut saat war boss dibuka',
          '`!warlist` — lihat daftar peserta war boss',
          '`!dmjam` — lihat jadwal DM otomatis',
          'Tanya apa aja soal order/slot — Bloxy jawab otomatis (sebut "bloxy" atau mention)',
        ].join('\n'),
      },
      {
        name: '⚔️ War boss (Admin)',
        value: [
          '`!war boss [keterangan]` — buka pendaftaran di channel ini',
          '`!warhapus <slot-nomor|@user|semua>` — hapus peserta (contoh `1-5` = Slot 1 nomor 5)',
          '`!warpindah <slot-nomor|@user> <slot>` — pindahin peserta ke slot lain',
          '`!wartukar <slot-nomor> <slot-nomor>` — tukar slot dua peserta',
          '`!warselesai` — tutup pendaftaran + tampilkan daftar akhir',
        ].join('\n'),
      },
      {
        name: '🛠️ Moderasi (Admin)',
        value: [
          '`!hapus <jumlah>` — hapus N pesan terakhir (1–100)',
          '`!timeout @user 10m [alasan]` — timeout member',
          '`!addrole @user @role` / `!removerole @user @role`',
          '`!diam` / `!kembali bicara` — bikin bot diam / aktif lagi',
        ].join('\n'),
      },
      {
        name: '📢 Pengumuman & jadwal (Admin)',
        value: [
          '`!umumin <teks>` — kirim pengumuman',
          '`!poll [durasi] Pertanyaan | opsi 1 | opsi 2` — voting pakai tombol (1 orang 1 suara)',
          '`!dm @user <1|2>` — catat user buat DM reminder slot',
          '`!dmjam <hari> <HH:MM>` — ubah jadwal DM otomatis',
          '`!reminder sekali DD-MM-YYYY HH:MM <pesan>` / `!reminder harian HH:MM <pesan>`',
          '`!reminderlist` / `!reminderhapus <nomor>`',
        ].join('\n'),
      },
      {
        name: '🧠 Memori bot (orang tertentu)',
        value: '`!ingat <teks>` • `!listmemori` • `!lupain <nomor>`',
      }
    )
    .setFooter({ text: 'Command bertanda Admin cuma bisa dipakai Administrator.' });

  await message.channel.send({ embeds: [embed] });
}

// ====================================================================
// Router: panggil dari messageCreate. Return true kalau command ditangani.
// ====================================================================

async function handleExtraCommand(message, content) {
  const lower = content.toLowerCase();

  if (lower === '!help') {
    await handleHelpCommand(message);
    return true;
  }
  if (lower === '!dmjam' || lower.startsWith('!dmjam ')) {
    await handleDmTimeCommand(message, content);
    return true;
  }
  if (/^!war\s*boss(\s|$)/.test(lower)) {
    await handleWarBossCommand(message, content);
    return true;
  }
  if (lower === '!warlist') {
    await handleWarListCommand(message);
    return true;
  }
  if (lower === '!warhapus' || lower.startsWith('!warhapus ')) {
    await handleWarRemoveCommand(message, content);
    return true;
  }
  if (lower === '!warpindah' || lower.startsWith('!warpindah ')) {
    await handleWarMoveCommand(message, content);
    return true;
  }
  if (lower === '!wartukar' || lower.startsWith('!wartukar ')) {
    await handleWarSwapCommand(message, content);
    return true;
  }
  if (lower === '!warselesai') {
    await handleWarCloseCommand(message);
    return true;
  }
  return false;
}

module.exports = { handleExtraCommand, handleWarJoin, getDmSchedule, describeDmSchedule };
