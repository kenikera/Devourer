'use strict';

require('dotenv').config();

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ffmpegPath = require('ffmpeg-static');
const {
  ApplicationIntegrationType,
  AttachmentBuilder,
  Client,
  Events,
  GatewayIntentBits,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StickerFormatType,
} = require('discord.js');

const PREFIX = '?';
const DELETE_DELAY_MS = 3000;
const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const SHARE_MAX_BYTES = 8 * 1024 * 1024;
const MAX_BATCH = 50;
const MAX_CLEAR = 99;
const EMOJI_CONCURRENCY = 3;
const FFMPEG_TIMEOUT_MS = 60 * 1000;
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

const CUSTOM_EMOJI_REGEX = /<(a?):(\w+):(\d{15,25})>/g;
const EMOJI_TOKEN_REGEX = /^<a?:\w+:\d+>$/;
const URL_REGEX = /https?:\/\/[^\s<>]+/i;

const TYPE_ALIASES = {
  emoji: 'emoji',
  emojis: 'emoji',
  sticker: 'sticker',
  stricker: 'sticker',
  stiker: 'sticker',
};

const GIF_PROFILES = [
  { fps: 15, width: 480, seconds: 10 },
  { fps: 12, width: 360, seconds: 8 },
  { fps: 10, width: 320, seconds: 6 },
  { fps: 8, width: 240, seconds: 5 },
];

const REPLY_SETTING_KEYS = {
  success: 'deleteSuccessReply',
  error: 'deleteErrorReply',
};

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
} catch {
  settings = {};
}

const saveSettings = () =>
  fs.promises.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2)).catch(console.error);

const isAutoDeleteEnabled = (guildId) => settings[guildId]?.autoDeleteCmd !== false;
const shouldDeleteReply = (guildId, kind) => settings[guildId]?.[REPLY_SETTING_KEYS[kind]] === true;

const handledMessages = new Set();

function markHandled(id) {
  if (handledMessages.has(id)) return false;
  handledMessages.add(id);
  setTimeout(() => handledMessages.delete(id), 60 * 1000);
  return true;
}

const suffix = () => Date.now().toString(36);
const fail = (text) => ({ ok: false, text });
const succeed = (text, files) => ({ ok: true, text, files });

function deleteLater(message, delay = DELETE_DELAY_MS) {
  if (!message) return;
  setTimeout(() => message.delete().catch(() => {}), delay);
}

function sanitizeName(raw, fallback, max = 32) {
  const name = String(raw ?? '')
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .slice(0, max);
  return name.length >= 2 ? name : fallback;
}

function parseEmojis(text = '') {
  const seen = new Set();
  const result = [];
  for (const match of text.matchAll(CUSTOM_EMOJI_REGEX)) {
    const [, animatedFlag, name, id] = match;
    if (seen.has(id)) continue;
    seen.add(id);
    const animated = animatedFlag === 'a';
    result.push({
      name,
      animated,
      url: `https://cdn.discordapp.com/emojis/${id}.${animated ? 'gif' : 'png'}?size=128`,
    });
  }
  return result;
}

function collectEmojiSources(message) {
  const sources = parseEmojis(message.content);
  if (sources.length) return sources;
  for (const attachment of message.attachments.values()) {
    if (attachment.contentType?.startsWith('image/')) {
      sources.push({
        name: path.parse(attachment.name ?? 'emoji').name,
        animated: attachment.contentType === 'image/gif',
        url: attachment.url,
      });
    }
  }
  return sources;
}

function findMediaUrl(message) {
  for (const attachment of message.attachments.values()) {
    const type = attachment.contentType ?? '';
    if (type.startsWith('image/') || type.startsWith('video/')) return attachment.url;
  }
  for (const embed of message.embeds) {
    const url = embed.video?.url ?? embed.image?.url ?? embed.thumbnail?.url;
    if (url) return url;
  }
  return message.content.match(URL_REGEX)?.[0] ?? null;
}

function describeError(error) {
  switch (error?.code) {
    case 30008:
      return 'This server has no free emoji slots left.';
    case 30039:
      return 'This server has no free sticker slots left.';
    case 50013:
      return 'I am missing permissions to do that.';
    case 50035:
      return 'Discord rejected the file (invalid format or too large).';
    default:
      return error?.message ?? 'Unknown error.';
  }
}

function formatResult(added, failed) {
  const lines = [];
  if (added.length) lines.push(`Added: ${added.join(' ')}`);
  if (failed.length) lines.push(`Failed:\n${failed.map((item) => `- ${item}`).join('\n')}`);
  return lines.join('\n');
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  });

  await Promise.all(runners);
  return results;
}

async function addEmojiSources(guild, sources, requestedName, reason) {
  const single = sources.length === 1;

  const results = await mapLimit(sources.slice(0, MAX_BATCH), EMOJI_CONCURRENCY, async (source) => {
    const name = sanitizeName(single && requestedName ? requestedName : source.name, `emoji_${suffix()}`);
    try {
      const emoji = await guild.emojis.create({ attachment: source.url, name, reason });
      return { added: emoji.toString() };
    } catch (error) {
      return { failed: `${source.name}: ${describeError(error)}` };
    }
  });

  return {
    added: results.filter((item) => item.added).map((item) => item.added),
    failed: results.filter((item) => item.failed).map((item) => item.failed),
  };
}

function runFfmpeg(inputPath, outputPath, { fps, width, seconds }) {
  const filter =
    `fps=${fps},scale=w='min(${width},iw)':h=-1:flags=lanczos,` +
    'split[a][b];[a]palettegen=max_colors=256[p];[b][p]paletteuse=dither=bayer:bayer_scale=3';

  const args = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-t',
    String(seconds),
    '-i',
    inputPath,
    '-vf',
    filter,
    '-an',
    '-loop',
    '0',
    outputPath,
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args);
    let stderr = '';
    const timer = setTimeout(() => proc.kill('SIGKILL'), FFMPEG_TIMEOUT_MS);

    proc.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    proc.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Conversion failed: ${stderr.slice(0, 200) || `exit code ${code}`}`));
    });
  });
}

async function convertToGif(url) {
  if (!ffmpegPath) throw new Error('ffmpeg is not available. Run: npm install ffmpeg-static');

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (${response.status}).`);

  const input = Buffer.from(await response.arrayBuffer());
  if (input.length > MAX_INPUT_BYTES) throw new Error('The source file is too large (max 50 MB).');

  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dcgif-'));
  const inputPath = path.join(dir, 'input');
  const outputPath = path.join(dir, 'output.gif');

  try {
    await fs.promises.writeFile(inputPath, input);
    for (const profile of GIF_PROFILES) {
      await runFfmpeg(inputPath, outputPath, profile);
      const output = await fs.promises.readFile(outputPath);
      if (output.length <= SHARE_MAX_BYTES) return output;
    }
    throw new Error('Could not shrink the GIF under 8 MB. Try a shorter video.');
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

function detectKind(target) {
  if (target.stickers.size) return 'sticker';
  if (parseEmojis(target.content).length) return 'emoji';
  if ([...target.attachments.values()].some((attachment) => attachment.contentType?.startsWith('image/'))) {
    return 'emoji';
  }
  return null;
}

async function runAddCommand(message, requestedKind, nameArg) {
  const { guild } = message;
  const member = message.member ?? (await guild.members.fetch(message.author.id));

  if (!member.permissions.has(PermissionFlagsBits.ManageGuildExpressions)) {
    return fail('You need the Manage Expressions permission to use this command.');
  }

  const target = message.reference?.messageId ? await message.fetchReference().catch(() => null) : null;
  const reason = `Added by ${message.author.username}`;

  let kind = requestedKind;
  if (kind === 'auto') {
    if (!target) return fail('Reply to a message you want to add, or use ?add emoji / sticker, or ?make gif.');
    kind = detectKind(target);
    if (!kind) return fail('I could not find an emoji, sticker or image in that message. Use ?make gif for videos.');
  }

  if (kind === 'emoji') {
    const all = [...(target ? collectEmojiSources(target) : []), ...parseEmojis(message.content)];
    const sources = [...new Map(all.map((source) => [source.url, source])).values()];
    if (!sources.length) {
      return fail('Reply to a message that contains a custom emoji, or include one in the command.');
    }
    const { added, failed } = await addEmojiSources(guild, sources, nameArg, reason);
    const text = formatResult(added, failed);
    return added.length ? succeed(text) : fail(text);
  }

  if (kind === 'sticker') {
    const sticker = target?.stickers.first();
    if (!sticker) {
      return fail(
        target && findMediaUrl(target)
          ? 'That message has no sticker. Use ?add emoji for images or ?make gif for videos.'
          : 'Reply to a message that contains a sticker.',
      );
    }
    if (sticker.format === StickerFormatType.Lottie) {
      return fail('Lottie stickers cannot be added to servers.');
    }

    const created = await guild.stickers.create({
      file: sticker.url,
      name: sanitizeName(nameArg ?? sticker.name, `sticker_${suffix()}`, 30),
      tags: String(sticker.tags || sticker.name).slice(0, 200),
      description: sticker.description || undefined,
      reason,
    });
    return succeed(`Sticker added: ${created.name}`);
  }

  return fail('Unknown type. Use ?add emoji or ?add sticker.');
}

async function runMakeCommand(message, type) {
  if (type?.toLowerCase() !== 'gif') return fail('Usage: ?make gif (reply to an image or video).');

  const target = message.reference?.messageId ? await message.fetchReference().catch(() => null) : null;
  const mediaUrl = target ? findMediaUrl(target) : null;
  if (!mediaUrl) return fail('Reply to a message that contains an image, video or GIF.');

  const buffer = await convertToGif(mediaUrl);
  return succeed('Here is your GIF.', [new AttachmentBuilder(buffer, { name: `converted_${suffix()}.gif` })]);
}

async function runClearCommand(message, argument) {
  const { guild, channel } = message;
  const member = message.member ?? (await guild.members.fetch(message.author.id));

  if (!member.permissions.has(PermissionFlagsBits.ManageMessages)) {
    return fail('You need the Manage Messages permission to use this command.');
  }
  if (!channel.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.ManageMessages)) {
    return fail('I need the Manage Messages permission in this channel.');
  }

  const amount = Number.parseInt(argument, 10);
  if (!Number.isInteger(amount) || amount < 1 || amount > MAX_CLEAR) {
    return fail(`Usage: ?clear <1-${MAX_CLEAR}>`);
  }

  const deleted = await channel.bulkDelete(amount + 1, true);
  const count = Math.max(deleted.size - (deleted.has(message.id) ? 1 : 0), 0);
  return succeed(`Deleted ${count} message${count === 1 ? '' : 's'}. (Messages older than 14 days cannot be bulk deleted.)`);
}

const commands = [
  new SlashCommandBuilder()
    .setName('add-emoji')
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
    .setContexts(InteractionContextType.Guild)
    .setDescription('Add a custom emoji from another server to this server')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuildExpressions)
    .addStringOption((option) =>
      option.setName('emoji').setDescription('The emoji (or emojis) to add').setRequired(true),
    )
    .addStringOption((option) =>
      option.setName('emoji-name').setDescription('Custom name for the emoji').setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName('auto-delete-cmd')
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
    .setContexts(InteractionContextType.Guild)
    .setDescription('Toggle automatic deletion of ? command messages')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addBooleanOption((option) =>
      option.setName('enabled').setDescription('true = delete, false = keep').setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('delete')
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
    .setContexts(InteractionContextType.Guild)
    .setDescription('Toggle automatic deletion of the bot replies after 3 seconds')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((option) =>
      option
        .setName('reply')
        .setDescription('Which bot replies to delete')
        .setRequired(true)
        .addChoices({ name: 'success', value: 'success' }, { name: 'error', value: 'error' }),
    )
    .addBooleanOption((option) =>
      option.setName('enabled').setDescription('true = delete, false = keep').setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('make')
    .setDescription('Convert media into a ready to use GIF')
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall)
    .setContexts(
      InteractionContextType.Guild,
      InteractionContextType.BotDM,
      InteractionContextType.PrivateChannel,
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('gif')
        .setDescription('Turn an image or video into a GIF')
        .addAttachmentOption((option) =>
          option.setName('file').setDescription('The image or video to convert').setRequired(true),
        ),
    ),
];

async function handleMakeSlash(interaction) {
  const file = interaction.options.getAttachment('file', true);
  const type = file.contentType ?? '';

  await interaction.deferReply();

  try {
    if (!type.startsWith('image/') && !type.startsWith('video/')) {
      throw new Error('Please attach an image, video or GIF.');
    }

    const buffer = await convertToGif(file.url);
    await interaction.editReply({
      files: [new AttachmentBuilder(buffer, { name: `converted_${suffix()}.gif` })],
    });
  } catch (error) {
    console.error(error);
    await interaction.deleteReply().catch(() => {});
    await interaction
      .followUp({ content: describeError(error), flags: MessageFlags.Ephemeral })
      .catch(() => {});
  }
}

async function handleAddEmojiSlash(interaction) {
  if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuildExpressions)) {
    return interaction.reply({
      content: 'You need the Manage Expressions permission to use this command.',
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const input = interaction.options.getString('emoji', true);
  const requestedName = interaction.options.getString('emoji-name');

  let sources = parseEmojis(input);
  if (!sources.length) {
    const url = input.match(URL_REGEX)?.[0];
    if (url) sources = [{ name: 'emoji', animated: false, url }];
  }

  if (!sources.length) {
    return interaction.editReply('No custom emoji or image link found in your input.');
  }
  if (requestedName && sources.length > 1) {
    return interaction.editReply('emoji-name can only be used when adding a single emoji.');
  }

  const { added, failed } = await addEmojiSources(
    interaction.guild,
    sources,
    requestedName,
    `Added by ${interaction.user.username}`,
  );

  return interaction.editReply(formatResult(added, failed) || 'Nothing was added.');
}

async function handleAutoDeleteSlash(interaction) {
  if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
    return interaction.reply({
      content: 'You need the Manage Server permission to change this setting.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const enabled = interaction.options.getBoolean('enabled', true);
  settings[interaction.guildId] = { ...settings[interaction.guildId], autoDeleteCmd: enabled };
  await saveSettings();

  return interaction.reply({
    content: `Auto delete of command messages is now ${enabled ? 'ON' : 'OFF'}.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleDeleteSlash(interaction) {
  if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
    return interaction.reply({
      content: 'You need the Manage Server permission to change this setting.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const kind = interaction.options.getString('reply', true);
  const enabled = interaction.options.getBoolean('enabled', true);
  settings[interaction.guildId] = { ...settings[interaction.guildId], [REPLY_SETTING_KEYS[kind]]: enabled };
  await saveSettings();

  return interaction.reply({
    content: `Auto delete of ${kind} replies is now ${enabled ? 'ON' : 'OFF'}.`,
    flags: MessageFlags.Ephemeral,
  });
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.once(Events.ClientReady, async (readyClient) => {
  try {
    await readyClient.application.commands.set(commands.map((command) => command.toJSON()));
    console.log(`Logged in as ${readyClient.user.tag} | Slash commands registered.`);
  } catch (error) {
    console.error('Failed to register slash commands:', error);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName !== 'make' && !interaction.inGuild()) {
    return interaction.reply({
      content: 'This command can only be used in a server.',
      flags: MessageFlags.Ephemeral,
    });
  }

  try {
    if (interaction.commandName === 'add-emoji') await handleAddEmojiSlash(interaction);
    else if (interaction.commandName === 'auto-delete-cmd') await handleAutoDeleteSlash(interaction);
    else if (interaction.commandName === 'delete') await handleDeleteSlash(interaction);
    else if (interaction.commandName === 'make') await handleMakeSlash(interaction);
  } catch (error) {
    console.error(error);
    const content = describeError(error);
    if (interaction.deferred || interaction.replied) await interaction.editReply(content).catch(() => {});
    else await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild || !message.content.startsWith(PREFIX)) return;

  const [command, ...args] = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const commandName = command?.toLowerCase();
  if (!['add', 'clear', 'make'].includes(commandName)) return;
  if (!markHandled(message.id)) return;

  const pending = commandName === 'clear' ? null : message.react('⏳').catch(() => null);

  let result;
  try {
    if (commandName === 'clear') {
      result = await runClearCommand(message, args[0]);
    } else if (commandName === 'make') {
      message.channel.sendTyping().catch(() => {});
      result = await runMakeCommand(message, args[0]);
    } else if (args[0]?.toLowerCase() === 'gif') {
      result = fail('Use ?make gif instead (reply to an image or video).');
    } else {
      const explicitKind = TYPE_ALIASES[args[0]?.toLowerCase()];
      const rest = explicitKind ? args.slice(1) : args;
      const nameArg = rest.find((token) => !EMOJI_TOKEN_REGEX.test(token) && !/^https?:\/\//i.test(token));

      message.channel.sendTyping().catch(() => {});
      result = await runAddCommand(message, explicitKind ?? 'auto', nameArg);
    }
  } catch (error) {
    console.error(error);
    result = fail(describeError(error));
  }

  const reply = await message.channel
    .send({
      content: `${message.author} ${result.text || 'Nothing was added.'}`,
      files: result.files ?? [],
      allowedMentions: { parse: [] },
    })
    .catch((error) => {
      console.error(error);
      return null;
    });

  if (commandName === 'clear') {
    deleteLater(reply);
    return;
  }

  pending?.then((reaction) => reaction?.users.remove(client.user.id).catch(() => {}));

  const keepReply = commandName === 'make' && result.ok;
  if (!keepReply && shouldDeleteReply(message.guild.id, result.ok ? 'success' : 'error')) deleteLater(reply);
  if (isAutoDeleteEnabled(message.guild.id)) deleteLater(message);
});

process.on('unhandledRejection', (error) => console.error('Unhandled rejection:', error));
process.on('uncaughtException', (error) => console.error('Uncaught exception:', error));
client.on(Events.Error, (error) => console.error('Client error:', error));
client.on(Events.ShardError, (error) => console.error('Shard error:', error));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function start() {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    console.error('Missing DISCORD_TOKEN in the .env file.');
    process.exit(1);
  }

  for (;;) {
    try {
      await client.login(token);
      return;
    } catch (error) {
      if (error?.code === 'TokenInvalid' || error?.code === 'DisallowedIntents') {
        console.error(
          error.code === 'TokenInvalid'
            ? 'Invalid token. Check DISCORD_TOKEN in the .env file.'
            : 'Disallowed intents. Enable Message Content Intent in the Developer Portal.',
        );
        process.exit(1);
      }
      console.error(`Login failed (${error?.message ?? error}). Retrying in 10 seconds...`);
      await wait(10 * 1000);
    }
  }
}

start();
