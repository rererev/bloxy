// welcome.js — pesan sambutan otomatis untuk member baru.
//
// Pakai di index.js (satu baris, setelah `const client = new Client(...)`):
//   require('./welcome')(client);
//
// Contoh hasil:
//   "Selamat datang @Budi! Semoga betah di BLOX GANK 🎉
//    Ambil role dulu di #ambil-role ya, supaya semua channel kebuka!"
//
// Command (khusus Administrator):
//   !welcome                     → lihat pengaturan sekarang
//   !welcome channel [#channel]  → channel tempat pesan sambutan dikirim (default: channel tempat command diketik)
//   !welcome role #channel       → channel untuk ambil role (muncul sebagai #channel yang bisa diklik)
//   !welcome pesan <teks>        → ganti isi pesan. Placeholder: {user} {server} {role}
//   !welcome tes                 → kirim contoh pesan (pakai kamu sebagai member baru)
//   !welcome off / !welcome on   → matikan / nyalakan
//
// ENV opsional (nilai awal, bisa ditimpa lewat command):
//   WELCOME_CHANNEL_ID, WELCOME_ROLE_CHANNEL_ID

const fs = require('fs');
const path = require('path');
const { PermissionsBitField } = require('discord.js');

const DATA_DIR = process.env.DATA_DIR ? process.env.DATA_DIR : __dirname;
const FILE = path.join(DATA_DIR, 'welcome.json');

const DEFAULT_TEMPLATE =
  'Selamat datang {user}! Semoga betah di **{server}** 🎉\nAmbil role dulu di {role} ya, supaya semua channel kebuka!';
const MAX_TEMPLATE = 1500;
const SPACING_MS = 1500; // jeda minimal antar pesan sambutan (anti-spam kalau banyak yang join sekaligus)

function load() {
  const base = {
    enabled: true,
    channelId: (process.env.WELCOME_CHANNEL_ID || '').trim(),
    roleChannelId: (process.env.WELCOME_ROLE_CHANNEL_ID || '').trim(),
    template: DEFAULT_TEMPLATE,
  };
  try {
    if (fs.existsSync(FILE)) return { ...base, ...JSON.parse(fs.readFileSync(FILE, 'utf-8')) };
  } catch (err) {
    console.error('[Welcome] Gagal load welcome.json:', err);
  }
  return base;
}

let settings = load();

function save() {
  try {
    fs.writeFileSync(FILE, JSON.stringify(settings, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Welcome] Gagal simpan welcome.json:', err);
  }
}

function render(userId, guildName) {
  const roleText = settings.roleChannelId ? `<#${settings.roleChannelId}>` : '**channel role**';
  return settings.template
    .replace(/\{user\}/gi, `<@${userId}>`)
    .replace(/\{server\}/gi, guildName)
    .replace(/\{role\}/gi, roleText);
}

let chain = Promise.resolve(); // antrian kirim, supaya ada jeda antar pesan
function enqueue(task) {
  chain = chain
    .then(task)
    .catch((err) => console.error('[Welcome] Gagal kirim pesan sambutan:', err.message))
    .then(() => new Promise((r) => setTimeout(r, SPACING_MS)));
}

async function handleCommand(message, content) {
  if (!message.member?.permissions?.has(PermissionsBitField.Flags.Administrator)) {
    await message.reply('Command ini cuma buat Administrator yaa 🙏');
    return;
  }

  const parts = content.trim().split(/\s+/);
  const sub = (parts[1] || '').toLowerCase();
  const mentioned = message.mentions.channels?.first();
  const noPing = { parse: [], repliedUser: false };

  if (!sub) {
    await message.reply({
      content:
        `👋 **Pesan sambutan** — ${settings.enabled ? 'aktif' : 'nonaktif'}\n` +
        `Channel sambutan: ${settings.channelId ? `<#${settings.channelId}>` : '_belum di-set_'}\n` +
        `Channel ambil role: ${settings.roleChannelId ? `<#${settings.roleChannelId}>` : '_belum di-set_'}\n` +
        `Isi pesan:\n>>> ${settings.template}\n\n` +
        'Atur: `!welcome channel #x` • `!welcome role #x` • `!welcome pesan <teks>` • `!welcome tes` • `!welcome off`',
      allowedMentions: noPing,
    });
    return;
  }

  if (sub === 'channel') {
    const target = mentioned || message.channel;
    settings.channelId = target.id;
    save();
    await message.reply({ content: `✅ Pesan sambutan akan dikirim di <#${target.id}>.`, allowedMentions: noPing });
    return;
  }

  if (sub === 'role') {
    if (!mentioned) {
      await message.reply('Format: `!welcome role #channel-ambil-role` — mention channel tempat member ambil role.');
      return;
    }
    settings.roleChannelId = mentioned.id;
    save();
    await message.reply({ content: `✅ Channel ambil role di-set ke <#${mentioned.id}>.`, allowedMentions: noPing });
    return;
  }

  if (sub === 'pesan') {
    const text = content.replace(/^!welcome\s+pesan\s*/i, '').trim();
    if (!text) {
      await message.reply('Format: `!welcome pesan <teks>` — placeholder: `{user}` `{server}` `{role}`.\nContoh: `!welcome pesan Halo {user}! Ambil role di {role} ya 🎉`');
      return;
    }
    if (text.length > MAX_TEMPLATE) {
      await message.reply(`Pesannya kepanjangan (maks ${MAX_TEMPLATE} karakter).`);
      return;
    }
    settings.template = text;
    save();
    await message.reply({ content: `✅ Pesan sambutan diganti. Coba lihat hasilnya pakai \`!welcome tes\`.`, allowedMentions: noPing });
    return;
  }

  if (sub === 'tes' || sub === 'test') {
    await message.channel.send({
      content: render(message.author.id, message.guild.name),
      allowedMentions: { users: [message.author.id] },
    });
    return;
  }

  if (sub === 'off' || sub === 'on') {
    settings.enabled = sub === 'on';
    save();
    await message.reply(settings.enabled ? '✅ Pesan sambutan dinyalakan.' : '✅ Pesan sambutan dimatikan.');
    return;
  }

  await message.reply('Format: `!welcome` / `!welcome channel #x` / `!welcome role #x` / `!welcome pesan <teks>` / `!welcome tes` / `!welcome on|off`');
}

module.exports = function initWelcome(client) {
  // Member baru join
  client.on('guildMemberAdd', (member) => {
    if (!settings.enabled || member.user?.bot || !settings.channelId) return;
    enqueue(async () => {
      const channel = await member.guild.channels.fetch(settings.channelId).catch(() => null);
      if (!channel?.send) return;
      await channel.send({
        content: render(member.id, member.guild.name),
        allowedMentions: { users: [member.id] },
      });
    });
  });

  // Command !welcome (listener terpisah, gak ganggu handler messageCreate utama)
  client.on('messageCreate', async (message) => {
    try {
      if (!message.guild || message.author?.bot || message.webhookId) return;
      const content = message.content || '';
      if (!/^!welcome(\s|$)/i.test(content)) return;
      await handleCommand(message, content);
    } catch (err) {
      console.error('[Welcome] Error command:', err);
    }
  });
};
