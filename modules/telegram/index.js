// Telegram 채널 모듈. grammY(MIT)를 씁니다. 롱 폴링으로 메시지를 받아 ctx.emit 으로 넘깁니다.
import { Bot, GrammyError, HttpError } from 'grammy';

const MAX_LEN = 4096;
let bot = null;

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

function describeError(err) {
  if (err instanceof GrammyError) {
    if (err.error_code === 401) return 'TELEGRAM_BOT_TOKEN 이 거부되었습니다 (401 Unauthorized). @BotFather 에서 토큰을 확인해 .env 에 넣으세요.';
    if (err.error_code === 409) return '같은 토큰으로 다른 곳에서 봇이 이미 실행 중입니다 (409 Conflict). 다른 프로세스를 끄세요.';
    if (err.error_code === 403) return `봇이 이 대화에 메시지를 보낼 수 없습니다 (403): ${err.description}`;
    if (err.error_code === 400) return `Telegram 이 요청을 거부했습니다 (400): ${err.description}`;
    return `Telegram API 오류 (${err.error_code}): ${err.description}`;
  }
  if (err instanceof HttpError) return `Telegram 서버에 연결하지 못했습니다: ${err.message}`;
  return `Telegram 오류: ${err?.message ?? err}`;
}

export default {
  async activate(ctx) {
    bot = new Bot(ctx.env.TELEGRAM_BOT_TOKEN);
    let me;
    try {
      me = await bot.api.getMe();
    } catch (err) {
      throw new Error(describeError(err));
    }

    bot.on('message:text', (c) => {
      const chat = c.chat;
      const isPrivate = chat.type === 'private';
      const raw = c.message.text;
      const mention = `@${me.username}`;
      const mentioned = raw.includes(mention) || c.message.reply_to_message?.from?.id === me.id;
      const text = raw.replaceAll(mention, '').trim();
      if (!text) return;
      const from = c.from;
      ctx.emit({
        target: String(chat.id),
        targetLabel: isPrivate ? `@${from?.username ?? from?.first_name ?? chat.id}` : (chat.title ?? String(chat.id)),
        userId: String(from?.id ?? ''),
        userName: [from?.first_name, from?.last_name].filter(Boolean).join(' ') || from?.username || '알 수 없음',
        text,
        direct: isPrivate || mentioned,
        messageId: String(c.message.message_id),
      });
    });

    bot.catch((err) => ctx.log.error(describeError(err.error)));
    // start() 는 봇이 멈출 때까지 끝나지 않으므로 기다리지 않습니다.
    bot.start({ onStart: (info) => ctx.log.info(`@${info.username} 로 연결했습니다`) }).catch((err) => {
      ctx.log.error(describeError(err));
      process.exit(1);
    });
  },

  async deactivate() {
    if (bot) await bot.stop();
    bot = null;
  },

  async send(target, text) {
    if (!bot) throw new Error('Telegram 에 연결되어 있지 않습니다.');
    const parts = splitText(text, MAX_LEN);
    try {
      for (const part of parts) await bot.api.sendMessage(target, part);
    } catch (err) {
      throw new Error(describeError(err));
    }
    return `보냄 (${parts.length}개 메시지)`;
  },

  tools: {},
};
