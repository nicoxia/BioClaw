/**
 * Telegram channel for BioClaw.
 * Uses Telegram Bot API via long-polling (getUpdates).
 * Supports inline keyboards and callback queries.
 * No external dependency — native Node.js fetch is sufficient.
 *
 * Env vars:
 *   TELEGRAM_BOT_TOKEN — required, from @BotFather
 */

import { logger } from '../logger.js';
import { Channel, OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../types.js';

const TELEGRAM_JID_SUFFIX_CHAT = '@telegram.chat';
const TELEGRAM_JID_SUFFIX_DM = '@telegram.dm';
const TELEGRAM_MESSAGE_LIMIT = 4096;
const POLL_TIMEOUT = 30;

export interface TelegramChannelOpts {
  token: string;
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  autoRegister?: (jid: string, name: string, channelName: string) => void;
}

interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

interface InlineKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

export class TelegramChannel implements Channel {
  name = 'telegram';
  prefixAssistantName = false;

  private token: string;
  private apiBase: string;
  private opts: TelegramChannelOpts;
  private connected = false;
  private offset = 0;
  private polling = false;
  private me: TelegramUser | null = null;

  constructor(opts: TelegramChannelOpts) {
    this.opts = opts;
    this.token = opts.token;
    this.apiBase = `https://api.telegram.org/bot${this.token}`;
  }

  async connect(): Promise<void> {
    const res = await this.api('getMe');
    if (!res.ok) {
      throw new Error(`Telegram auth failed: ${JSON.stringify(res)}`);
    }
    this.me = res.result;
    this.connected = true;
    logger.info(
      { botUsername: this.me!.username, botName: this.me!.first_name },
      'Connected to Telegram',
    );
    this.startPolling();
  }

  private async api(method: string, body?: Record<string, unknown>): Promise<any> {
    const url = `${this.apiBase}/${method}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json();
  }

  private startPolling(): void {
    this.polling = true;
    this.poll();
  }

  private async poll(): Promise<void> {
    if (!this.polling) return;

    try {
      const res = await this.api('getUpdates', {
        offset: this.offset,
        timeout: POLL_TIMEOUT,
        allowed_updates: ['message', 'callback_query'],
      });

      if (res.ok && Array.isArray(res.result)) {
        for (const update of res.result) {
          if (update.message) {
            this.handleMessage(update.message);
          }
          if (update.callback_query) {
            this.handleCallbackQuery(update.callback_query);
          }
          this.offset = update.update_id + 1;
        }
      }
    } catch (err) {
      logger.error({ err }, 'Telegram poll error');
      await new Promise((r) => setTimeout(r, 3000));
    }

    if (this.polling) {
      setImmediate(() => this.poll());
    }
  }

  private handleMessage(msg: any): void {
    if (!msg || !msg.text || !msg.from) return;
    if (msg.from.is_bot) return;

    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
    const chatId = msg.chat.id;
    const chatJid = isGroup
      ? `${chatId}${TELEGRAM_JID_SUFFIX_CHAT}`
      : `${msg.from.id}${TELEGRAM_JID_SUFFIX_DM}`;

    const senderName = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ')
      || msg.from.username || String(msg.from.id);

    const timestamp = new Date(msg.date * 1000).toISOString();
    let content = msg.text;

    if (isGroup) {
      const botUsername = this.me?.username;
      const isMentioned = botUsername ? content.includes(`@${botUsername}`) : false;
      if (!isMentioned) return;
      if (botUsername) {
        content = content.replace(new RegExp(`@${botUsername}\\s*`, 'g'), '').trim();
      }
    }

    if (!content) return;

    logger.info({ chatJid, sender: senderName, isGroup, contentPreview: content.slice(0, 80) }, 'Telegram message received');

    this.opts.onChatMetadata(chatJid, timestamp, isGroup ? (msg.chat.title || `Telegram Group ${chatId}`) : undefined);

    let groups = this.opts.registeredGroups();
    if (!groups[chatJid] && this.opts.autoRegister) {
      const chatName = isGroup ? `Telegram ${msg.chat.title || chatId}` : `Telegram DM ${senderName}`;
      this.opts.autoRegister(chatJid, chatName, 'telegram');
      groups = this.opts.registeredGroups();
    }

    if (groups[chatJid]) {
      this.opts.onMessage(chatJid, {
        id: String(msg.message_id),
        chat_jid: chatJid,
        sender: String(msg.from.id),
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    } else {
      logger.info({ chatJid }, 'Telegram message from unregistered chat, ignored');
    }
  }

  private async handleCallbackQuery(query: any): Promise<void> {
    const data = query.data as string;
    if (!data) return;

    const chatId = query.message?.chat?.id;
    const fromId = query.from?.id;

    logger.info({ data, chatId, fromId }, 'Telegram callback query received');

    // Answer the callback query immediately (remove loading state)
    await this.api('answerCallbackQuery', { callback_query_id: query.id });

    // Process as a regular message with the callback_data as content
    if (!chatId || !fromId) return;

    const isGroup = query.message.chat.type === 'group' || query.message.chat.type === 'supergroup';
    const chatJid = isGroup
      ? `${chatId}${TELEGRAM_JID_SUFFIX_CHAT}`
      : `${fromId}${TELEGRAM_JID_SUFFIX_DM}`;

    const senderName = [query.from.first_name, query.from.last_name].filter(Boolean).join(' ')
      || query.from.username || String(fromId);

    const timestamp = new Date().toISOString();

    this.opts.onChatMetadata(chatJid, timestamp);
    let groups = this.opts.registeredGroups();

    if (groups[chatJid]) {
      this.opts.onMessage(chatJid, {
        id: `cb-${query.id}`,
        chat_jid: chatJid,
        sender: String(fromId),
        sender_name: senderName,
        content: data,
        timestamp,
        is_from_me: false,
      });
    }
  }

  async sendMessage(jid: string, text: string, replyMarkup?: InlineKeyboard): Promise<void> {
    const chatId = this.extractChatId(jid);
    if (!chatId) {
      logger.warn({ jid }, 'Cannot resolve Telegram chat ID');
      return;
    }

    const chunks = this.splitMessage(text, TELEGRAM_MESSAGE_LIMIT);
    for (let i = 0; i < chunks.length; i++) {
      const body: Record<string, unknown> = {
        chat_id: chatId,
        text: chunks[i],
      };
      // Only attach keyboard to the last chunk
      if (replyMarkup && i === chunks.length - 1) {
        body.reply_markup = replyMarkup;
      }
      const res = await this.api('sendMessage', body);
      if (!res.ok) {
        logger.warn({ chatId, error: res.description }, 'Telegram sendMessage failed');
      }
    }
    logger.info({ jid, length: text.length, chunks: chunks.length }, 'Telegram message sent');
  }

  async sendModelPicker(jid: string, currentModel: string): Promise<void> {
    const chatId = this.extractChatId(jid);
    if (!chatId) return;

    const models = [
      { id: 'qwen/qwen3-next-80b-a3b-instruct', label: '⚡ Qwen3-Next 80B' },
      { id: 'mistralai/mistral-small-3.1-24b-instruct-2503', label: '⚡ Mistral Small' },
      { id: 'stepfun-ai/step-3.5-flash', label: '⚡ Step-3.5 Flash' },
      { id: 'qwen/qwen3.5-122b-a10b', label: '⚡ Qwen3.5 122B' },
      { id: 'deepseek-ai/deepseek-v3.1', label: '🔧 DeepSeek V3.1' },
      { id: 'qwen/qwen3.5-397b-a17b', label: '🔧 Qwen3.5 397B' },
      { id: 'deepseek-ai/deepseek-v3.2', label: '💪 DeepSeek V3.2' },
      { id: 'qwen/qwen3-coder-480b-a35b-instruct', label: '💪 Qwen3-Coder 480B' },
    ];

    // Build inline keyboard (2 columns)
    const rows: Array<Array<{ text: string; callback_data: string }>> = [];
    for (let i = 0; i < models.length; i += 2) {
      const row = [
        {
          text: models[i].id === currentModel ? `✅ ${models[i].label}` : models[i].label,
          callback_data: `/model switch ${models[i].id}`,
        },
      ];
      if (i + 1 < models.length) {
        row.push({
          text: models[i + 1].id === currentModel ? `✅ ${models[i + 1].label}` : models[i + 1].label,
          callback_data: `/model switch ${models[i + 1].id}`,
        });
      }
      rows.push(row);
    }

    const keyboard: InlineKeyboard = { inline_keyboard: rows };

    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: `🤖 选择模型（当前: ${currentModel.split('/').pop()}）`,
      reply_markup: keyboard,
    };

    await this.api('sendMessage', body);
  }

  async sendImage(jid: string, imagePath: string, caption?: string): Promise<void> {
    const chatId = this.extractChatId(jid);
    if (!chatId) {
      logger.warn({ jid, imagePath }, 'Cannot resolve Telegram chat ID for image');
      return;
    }

    const fs = await import('fs');
    const formData = new FormData();
    formData.append('chat_id', String(chatId));
    if (caption) formData.append('caption', caption);
    formData.append('photo', new Blob([fs.readFileSync(imagePath)]), 'image.png');

    const url = `${this.apiBase}/sendPhoto`;
    await fetch(url, { method: 'POST', body: formData });
    logger.info({ jid, imagePath }, 'Telegram image sent');
  }

  async setTyping(jid: string): Promise<void> {
    const chatId = this.extractChatId(jid);
    if (!chatId) return;
    await this.api('sendChatAction', { chat_id: chatId, action: 'typing' });
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith(TELEGRAM_JID_SUFFIX_CHAT) || jid.endsWith(TELEGRAM_JID_SUFFIX_DM);
  }

  async disconnect(): Promise<void> {
    this.polling = false;
    this.connected = false;
    logger.info('Disconnected from Telegram');
  }

  private extractChatId(jid: string): number | null {
    const id = jid.replace(TELEGRAM_JID_SUFFIX_CHAT, '').replace(TELEGRAM_JID_SUFFIX_DM, '');
    const num = parseInt(id, 10);
    return isNaN(num) ? null : num;
  }

  private splitMessage(text: string, limit: number): string[] {
    if (text.length <= limit) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= limit) { chunks.push(remaining); break; }
      let splitAt = remaining.lastIndexOf('\n', limit);
      if (splitAt < limit * 0.3) splitAt = remaining.lastIndexOf(' ', limit);
      if (splitAt < limit * 0.3) splitAt = limit;
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }
    return chunks;
  }
}
