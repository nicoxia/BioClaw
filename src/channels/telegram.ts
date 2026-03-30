/**
 * Telegram channel for BioClaw.
 * Uses Telegram Bot API via long-polling (getUpdates).
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
const POLL_TIMEOUT = 30; // seconds

export interface TelegramChannelOpts {
  token: string;
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  autoRegister?: (jid: string, name: string, channelName: string) => void;
}

interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string; title?: string; username?: string };
  from?: { id: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string };
  text?: string;
  date: number;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
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
    // Verify token by getting bot info
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

    // Start long-polling loop
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
        allowed_updates: ['message'],
      });

      if (res.ok && Array.isArray(res.result)) {
        for (const update of res.result) {
          this.handleUpdate(update as TelegramUpdate);
          this.offset = update.update_id + 1;
        }
      }
    } catch (err) {
      logger.error({ err }, 'Telegram poll error');
      // Wait a bit before retrying on error
      await new Promise((r) => setTimeout(r, 3000));
    }

    // Continue polling
    if (this.polling) {
      setImmediate(() => this.poll());
    }
  }

  private handleUpdate(update: TelegramUpdate): void {
    const msg = update.message;
    if (!msg || !msg.text) return;
    if (!msg.from) return;

    // Ignore messages from bots
    if (msg.from.is_bot) return;

    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
    const chatId = msg.chat.id;
    const chatJid = isGroup
      ? `${chatId}${TELEGRAM_JID_SUFFIX_CHAT}`
      : `${msg.from.id}${TELEGRAM_JID_SUFFIX_DM}`;

    const senderName = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ')
      || msg.from.username
      || String(msg.from.id);

    const timestamp = new Date(msg.date * 1000).toISOString();
    let content = msg.text;

    // In groups, only respond when mentioned (@bot) or when the message is a reply to the bot
    if (isGroup) {
      const botUsername = this.me?.username;
      const isMentioned = botUsername ? content.includes(`@${botUsername}`) : false;

      if (!isMentioned) return;

      // Strip the @bot mention from content
      if (botUsername) {
        content = content.replace(new RegExp(`@${botUsername}\\s*`, 'g'), '').trim();
      }
    }

    if (!content) return;

    logger.info(
      { chatJid, sender: senderName, isGroup, contentPreview: content.slice(0, 80) },
      'Telegram message received',
    );

    this.opts.onChatMetadata(
      chatJid,
      timestamp,
      isGroup ? (msg.chat.title || `Telegram Group ${chatId}`) : undefined,
    );

    let groups = this.opts.registeredGroups();
    if (!groups[chatJid] && this.opts.autoRegister) {
      const chatName = isGroup
        ? `Telegram ${msg.chat.title || chatId}`
        : `Telegram DM ${senderName}`;
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

  async sendMessage(jid: string, text: string): Promise<void> {
    const chatId = this.extractChatId(jid);
    if (!chatId) {
      logger.warn({ jid }, 'Cannot resolve Telegram chat ID');
      return;
    }

    const chunks = this.splitMessage(text, TELEGRAM_MESSAGE_LIMIT);
    for (const chunk of chunks) {
      const res = await this.api('sendMessage', {
        chat_id: chatId,
        text: chunk,
        parse_mode: 'Markdown',
      });
      if (!res.ok) {
        // Retry without parse_mode if Markdown fails
        await this.api('sendMessage', {
          chat_id: chatId,
          text: chunk,
        });
      }
    }
    logger.info({ jid, length: text.length, chunks: chunks.length }, 'Telegram message sent');
  }

  async sendImage(jid: string, imagePath: string, caption?: string): Promise<void> {
    const chatId = this.extractChatId(jid);
    if (!chatId) {
      logger.warn({ jid, imagePath }, 'Cannot resolve Telegram chat ID for image');
      return;
    }

    // Use multipart form data to send photo
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
    await this.api('sendChatAction', {
      chat_id: chatId,
      action: 'typing',
    });
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
    const id = jid
      .replace(TELEGRAM_JID_SUFFIX_CHAT, '')
      .replace(TELEGRAM_JID_SUFFIX_DM, '');
    const num = parseInt(id, 10);
    return isNaN(num) ? null : num;
  }

  private splitMessage(text: string, limit: number): string[] {
    if (text.length <= limit) return [text];

    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= limit) {
        chunks.push(remaining);
        break;
      }
      let splitAt = remaining.lastIndexOf('\n', limit);
      if (splitAt < limit * 0.3) splitAt = remaining.lastIndexOf(' ', limit);
      if (splitAt < limit * 0.3) splitAt = limit;
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }
    return chunks;
  }
}
