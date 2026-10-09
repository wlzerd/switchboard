// Discord 채널 모듈. discord.js(Apache-2.0)를 씁니다.
// 받은 메시지는 ctx.emit 으로 서버에 넘기고, 서버가 보내라고 하면 send() 로 전송합니다.
import { once } from 'node:events';
import { ChannelType, Client, Events, GatewayIntentBits, Options, Partials } from 'discord.js';

const MAX_LEN = 2000;
let client = null;

function splitText(text, max) {
  const out = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

async function resolveChannel(target) {
  if (!client) throw new Error('Discord 에 연결되어 있지 않습니다.');
  if (target.startsWith('dm:')) {
    const user = await client.users.fetch(target.slice(3));
    return user.createDM();
  }
  if (/^\d+$/.test(target)) {
    const ch = await client.channels.fetch(target);
    if (!ch || !ch.isTextBased()) throw new Error(`채널 ${target} 은(는) 메시지를 보낼 수 있는 채널이 아닙니다.`);
    return ch;
  }
  const name = target.replace(/^#/, '').toLowerCase();
  const matches = client.channels.cache.filter((c) => c.type === ChannelType.GuildText && c.name.toLowerCase() === name);
  if (matches.size === 0) throw new Error(`봇이 볼 수 있는 #${name} 채널이 없습니다. 채널 이름을 확인하거나 봇을 그 채널에 초대하세요.`);
  if (matches.size > 1) throw new Error(`#${name} 채널이 여러 서버에 있습니다. 채널 id 로 지정하세요: ${matches.map((c) => `${c.guild.name}=${c.id}`).join(', ')}`);
  return matches.first();
}

export default {
  async activate(ctx) {
    client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
      partials: [Partials.Channel],
      // 24시간 도는 봇이 본 메시지 · 사용자 · 멤버를 끝없이 기억하지 않게 캐시 크기를 정합니다.
      // 받은 메시지는 바로 서버로 넘기므로 메시지 캐시는 두지 않습니다 (discord_read 는 그때그때 가져옴).
      makeCache: Options.cacheWithLimits({
        ...Options.DefaultMakeCacheSettings,
        MessageManager: 0,
        UserManager: { maxSize: 500, keepOverLimit: (user) => user.id === user.client.user?.id },
        GuildMemberManager: { maxSize: 500, keepOverLimit: (member) => member.id === member.client.user?.id },
        PresenceManager: 0,
        ReactionManager: 0,
      }),
    });

    client.on(Events.MessageCreate, (msg) => {
      if (msg.author.bot || !client.user) return;
      const isDM = msg.channel.type === ChannelType.DM;
      const mentioned = msg.mentions.users.has(client.user.id);
      const text = msg.content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
      if (!text) return;
      ctx.emit({
        target: isDM ? `dm:${msg.author.id}` : msg.channel.id,
        targetLabel: isDM ? 'DM' : `#${msg.channel.name}`,
        userId: msg.author.id,
        userName: msg.member?.displayName ?? msg.author.username,
        text,
        direct: isDM || mentioned,
        messageId: msg.id,
      });
    });
    client.on(Events.Error, (err) => ctx.log.error(`Discord 연결 오류: ${err.message}`));
    client.on(Events.ShardDisconnect, (ev) => ctx.log.warn(`Discord 연결이 끊겼습니다 (코드 ${ev.code}). 자동으로 다시 연결합니다.`));

    const ready = once(client, Events.ClientReady);
    try {
      await client.login(ctx.env.DISCORD_BOT_TOKEN);
    } catch (err) {
      const code = err?.code;
      if (code === 'TokenInvalid') throw new Error('DISCORD_BOT_TOKEN 이 거부되었습니다 (TokenInvalid). Discord 개발자 포털 > Bot 에서 토큰을 다시 발급해 .env 에 넣으세요.');
      if (code === 'DisallowedIntents' || String(err?.message).includes('disallowed intents')) {
        throw new Error('Message Content Intent 가 꺼져 있습니다. Discord 개발자 포털 > Bot > Privileged Gateway Intents 에서 MESSAGE CONTENT INTENT 를 켜세요.');
      }
      throw new Error(`Discord 로그인 실패: ${err?.message ?? err}`);
    }
    await ready;
    ctx.log.info(`${client.user.tag} 로 연결했습니다 · 서버 ${client.guilds.cache.size}곳`);
  },

  async deactivate() {
    if (client) await client.destroy();
    client = null;
  },

  async send(target, text) {
    const channel = await resolveChannel(target);
    const parts = splitText(text, MAX_LEN);
    for (const part of parts) await channel.send({ content: part, allowedMentions: { parse: [] } });
    return `보냄 (${parts.length}개 메시지)`;
  },

  tools: {
    async discord_channels() {
      if (!client) throw new Error('Discord 에 연결되어 있지 않습니다.');
      const rows = client.channels.cache
        .filter((c) => c.type === ChannelType.GuildText)
        .map((c) => `${c.guild.name} · #${c.name} · ${c.id}`);
      return rows.length > 0 ? rows.join('\n') : '봇이 볼 수 있는 텍스트 채널이 없습니다. 봇을 서버에 초대했는지 확인하세요.';
    },

    async discord_read(input) {
      const channel = await resolveChannel(input.channel);
      const limit = input.limit ?? 20;
      const messages = await channel.messages.fetch({ limit });
      const lines = [...messages.values()]
        .reverse()
        .map((m) => `[${new Date(m.createdTimestamp).toISOString()}] ${m.member?.displayName ?? m.author.username}: ${m.content}`);
      return lines.length > 0 ? lines.join('\n') : '메시지가 없습니다.';
    },
  },
};
