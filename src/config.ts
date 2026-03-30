import { loadEnvFile } from './env.js';
import { getHomeDir } from './platform.js';
import path from 'path';

loadEnvFile();

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Bioclaw';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;
export const ENABLE_WHATSAPP = process.env.ENABLE_WHATSAPP !== 'false';
export const ALLOW_WHATSAPP_SELF_MESSAGES =
  process.env.ALLOW_WHATSAPP_SELF_MESSAGES === 'true';
export const ENABLE_LOCAL_WEB = process.env.ENABLE_LOCAL_WEB === 'true';
export const LOCAL_WEB_HOST = process.env.LOCAL_WEB_HOST || 'localhost';
export const LOCAL_WEB_PORT = parseInt(process.env.LOCAL_WEB_PORT || '3000', 10);
export const LOCAL_WEB_GROUP_JID =
  process.env.LOCAL_WEB_GROUP_JID || 'local-web@local.web';
export const LOCAL_WEB_GROUP_NAME =
  process.env.LOCAL_WEB_GROUP_NAME || 'Local Web Chat';
export const LOCAL_WEB_GROUP_FOLDER =
  process.env.LOCAL_WEB_GROUP_FOLDER || 'local-web';
export const LOCAL_WEB_SECRET = process.env.LOCAL_WEB_SECRET || '';
export const QQ_APP_ID = process.env.QQ_APP_ID || '';
export const QQ_CLIENT_SECRET = process.env.QQ_CLIENT_SECRET || '';
export const QQ_SANDBOX = process.env.QQ_SANDBOX === 'true';
export const FEISHU_APP_ID = process.env.FEISHU_APP_ID || '';
export const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || '';
export const FEISHU_CONNECTION_MODE =
  (process.env.FEISHU_CONNECTION_MODE || 'websocket').toLowerCase();
export const FEISHU_VERIFICATION_TOKEN = process.env.FEISHU_VERIFICATION_TOKEN || '';
export const FEISHU_ENCRYPT_KEY = process.env.FEISHU_ENCRYPT_KEY || '';
export const FEISHU_HOST = process.env.FEISHU_HOST || '0.0.0.0';
export const FEISHU_PORT = parseInt(process.env.FEISHU_PORT || '8080', 10);
export const FEISHU_PATH = process.env.FEISHU_PATH || '/feishu/events';
export const ENABLE_WECHAT = process.env.ENABLE_WECHAT === 'true';
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

/** If set, require Authorization: Bearer <token> or ?token= on trace API routes */
export const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || '';

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = getHomeDir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'bioclaw',
  'mount-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const MAIN_GROUP_FOLDER = 'main';

export const CONTAINER_RUNTIME: 'docker' | 'apptainer' =
  (process.env.CONTAINER_RUNTIME || 'docker').toLowerCase() as 'docker' | 'apptainer';
export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'bioclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(
  process.env.IDLE_TIMEOUT || '1800000',
  10,
); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
