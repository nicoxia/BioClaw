import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  ASSISTANT_NAME,
  CONTAINER_IMAGE,
  CONTAINER_RUNTIME,
  ENABLE_LOCAL_WEB,
  ENABLE_WECHAT,
  ENABLE_WHATSAPP,
  FEISHU_APP_ID,
  GROUPS_DIR,
  LOCAL_WEB_GROUP_JID,
  QQ_APP_ID,
  TIMEZONE,
} from './config.js';
import { checkRuntime } from './container-runtime.js';
import {
  createTask,
  deleteTask,
  getAllTasks,
  getTaskById,
  updateTask,
} from './db/index.js';
import {
  archiveThreadForChat,
  bindChatToWorkspace,
  createThreadForChat,
  getCurrentThreadForChat,
  getAgentForChat,
  getAgentIdForChat,
  getAgentsMap,
  getChatJidsForAgent,
  getChatJidsForWorkspace,
  getRegisteredGroupsMap,
  getWorkspaceFolderForChat,
  listThreadsForChat,
  listWorkspaceFolders,
  renameThreadForChat,
  switchChatToThread,
  touchCurrentThreadForChat,
  upsertAgentDefinition,
} from './session-manager.js';
import { Channel, ScheduledTask } from './types.js';

export interface ThreadSummary {
  chatJid: string;
  title: string;
  workspaceFolder: string;
  addedAt: string;
  lastActivity?: string;
  agentId?: string;
}

export interface ControlPlaneDeps {
  channels: () => Channel[];
  listThreads?: () => ThreadSummary[];
  createThread?: (title?: string) => Promise<ThreadSummary>;
}

export interface ControlCommandResult {
  handled: boolean;
  response?: string;
  data?: unknown;
  dispatchPrompt?: string;
}

interface ProviderAvailability {
  anthropic: boolean;
  openrouter: boolean;
  openaiCompatible: boolean;
}

const WORKSPACE_GROUP_ROOT = '/workspace/group';
const DIR_HISTORY_LIMIT = 12;
const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const RESERVED_COMMANDS = new Set([
  'help',
  'status',
  'doctor',
  'provider',
  'model',
  'memory',
  'dir',
  'workspace',
  'cron',
  'heartbeat',
  'threads',
  'current',
  'new',
  'use',
  'switch',
  'rename',
  'archive',
  'commands',
  'alias',
]);

function tokenizeCommand(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === '\\' && i + 1 < input.length) {
        current += input[i + 1];
        i += 1;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (current) tokens.push(current);
  return tokens;
}

function getProviderAvailability(): ProviderAvailability {
  return {
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
    openrouter: Boolean(process.env.OPENROUTER_API_KEY),
    openaiCompatible: Boolean(process.env.OPENAI_COMPATIBLE_API_KEY),
  };
}

function resolveProviderName(value?: string): 'anthropic' | 'openrouter' | 'openai-compatible' {
  if (value === 'openrouter' || value === 'openai-compatible' || value === 'anthropic') {
    return value;
  }

  if (process.env.MODEL_PROVIDER === 'openrouter' || process.env.MODEL_PROVIDER === 'openai-compatible') {
    return process.env.MODEL_PROVIDER;
  }
  if (process.env.MODEL_PROVIDER === 'anthropic') return 'anthropic';
  if (process.env.OPENROUTER_API_KEY) return 'openrouter';
  if (process.env.OPENAI_COMPATIBLE_API_KEY) return 'openai-compatible';
  return 'anthropic';
}

function resolveModelName(provider: string, overrideModel?: string): string {
  if (overrideModel) return overrideModel;
  if (provider === 'openrouter') {
    return process.env.OPENROUTER_MODEL || 'openai/gpt-4.1-mini';
  }
  if (provider === 'openai-compatible') {
    return process.env.OPENAI_COMPATIBLE_MODEL || 'openai/gpt-4.1-mini';
  }
  return 'anthropic-default';
}

function computeNextRun(
  scheduleType: 'cron' | 'interval' | 'once',
  scheduleValue: string,
): string {
  if (scheduleType === 'cron') {
    const interval = CronExpressionParser.parse(scheduleValue, { tz: TIMEZONE });
    const nextRun = interval.next().toISOString();
    if (!nextRun) {
      throw new Error('Failed to compute next cron run.');
    }
    return nextRun;
  }
  if (scheduleType === 'interval') {
    const ms = parseInt(scheduleValue, 10);
    if (Number.isNaN(ms) || ms <= 0) {
      throw new Error('Interval must be a positive number of milliseconds.');
    }
    return new Date(Date.now() + ms).toISOString();
  }

  const scheduled = new Date(scheduleValue);
  if (Number.isNaN(scheduled.getTime())) {
    throw new Error('Invalid ISO timestamp for one-time task.');
  }
  return scheduled.toISOString();
}

function formatTask(task: ScheduledTask): string {
  const label = task.label ? `${task.label} ` : '';
  const nextRun = task.next_run || 'n/a';
  return `- ${task.id} ${label}[${task.status}] ${task.schedule_type}=${task.schedule_value} next=${nextRun}`;
}

function formatWorkspaceList(): string {
  const groups = getRegisteredGroupsMap();
  const agents = getAgentsMap();
  const lines = listWorkspaceFolders().map((workspaceFolder) => {
    const chats = getChatJidsForWorkspace(workspaceFolder).length;
    const agentCount = Object.values(agents).filter(
      (agent) => agent.workspaceFolder === workspaceFolder && !agent.archived,
    ).length;
    const titles = Object.entries(groups)
      .filter(([, group]) => (group.workspaceFolder || group.folder) === workspaceFolder)
      .map(([, group]) => group.name)
      .slice(0, 3)
      .join(', ');
    return `- ${workspaceFolder} (chats=${chats}, agents=${agentCount}${titles ? `, groups=${titles}` : ''})`;
  });
  return lines.length > 0 ? lines.join('\n') : 'No workspaces found.';
}

function normalizeThreadTitle(title?: string): string {
  const compact = (title || '').replace(/\s+/g, ' ').trim();
  return compact ? compact.slice(0, 80) : 'New thread';
}

function findThreadMatch(chatJid: string, query: string): ReturnType<typeof listThreadsForChat>[number] | undefined {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return undefined;
  const threads = listThreadsForChat(chatJid);
  return threads.find((thread) => thread.id === query.trim())
    || threads.find((thread) => thread.id.startsWith(query.trim()))
    || threads.find((thread) => thread.title.toLowerCase() === normalized)
    || threads.find((thread) => thread.title.toLowerCase().includes(normalized));
}

function normalizeStoredWorkdir(value?: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw || raw === '.' || raw === '/') return '.';
  if (raw.startsWith(WORKSPACE_GROUP_ROOT)) {
    const rel = path.posix.relative(WORKSPACE_GROUP_ROOT, path.posix.normalize(raw));
    if (!rel || rel === '.') return '.';
    if (rel.startsWith('..') || path.posix.isAbsolute(rel)) return '.';
    return rel;
  }
  if (raw.startsWith('/')) return '.';
  const normalized = path.posix.normalize(raw).replace(/^\/+/, '');
  if (!normalized || normalized === '.') return '.';
  if (normalized.startsWith('..')) return '.';
  return normalized;
}

function formatContainerWorkdir(relativeWorkdir?: string): string {
  const normalized = normalizeStoredWorkdir(relativeWorkdir);
  return normalized === '.'
    ? WORKSPACE_GROUP_ROOT
    : path.posix.join(WORKSPACE_GROUP_ROOT, normalized);
}

function getAgentDirHistory(agent?: { runtimeConfig?: { workdir?: string; dirHistory?: string[] } }): string[] {
  const current = normalizeStoredWorkdir(agent?.runtimeConfig?.workdir);
  const stored = Array.isArray(agent?.runtimeConfig?.dirHistory)
    ? agent.runtimeConfig.dirHistory
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => normalizeStoredWorkdir(entry))
    : [];
  const deduped = [current, ...stored.filter((entry) => entry !== current)];
  return Array.from(new Set(deduped)).slice(0, DIR_HISTORY_LIMIT);
}

function resolveRequestedWorkdir(request: string, currentRelativeWorkdir: string): string {
  const trimmed = request.trim();
  if (!trimmed || trimmed === '.' || trimmed === WORKSPACE_GROUP_ROOT) {
    return '.';
  }

  let targetAbsolute: string;
  if (trimmed.startsWith(WORKSPACE_GROUP_ROOT)) {
    targetAbsolute = path.posix.normalize(trimmed);
  } else if (trimmed.startsWith('/')) {
    throw new Error(`Directory must stay inside ${WORKSPACE_GROUP_ROOT}.`);
  } else {
    const base = currentRelativeWorkdir === '.'
      ? WORKSPACE_GROUP_ROOT
      : path.posix.join(WORKSPACE_GROUP_ROOT, currentRelativeWorkdir);
    targetAbsolute = path.posix.normalize(path.posix.join(base, trimmed));
  }

  const relative = path.posix.relative(WORKSPACE_GROUP_ROOT, targetAbsolute);
  if (relative.startsWith('..') || path.posix.isAbsolute(relative)) {
    throw new Error(`Directory must stay inside ${WORKSPACE_GROUP_ROOT}.`);
  }
  return relative && relative !== '.' ? relative : '.';
}

function ensureWorkspaceDirectoryExists(workspaceFolder: string, relativeWorkdir: string): string {
  const workspaceRoot = path.resolve(path.join(GROUPS_DIR, workspaceFolder));
  const target = path.resolve(
    path.join(workspaceRoot, relativeWorkdir === '.' ? '' : relativeWorkdir),
  );
  const relative = path.relative(workspaceRoot, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Resolved directory escapes the workspace root.');
  }
  if (!fs.existsSync(target)) {
    throw new Error(`Directory does not exist: ${formatContainerWorkdir(relativeWorkdir)}`);
  }
  if (!fs.statSync(target).isDirectory()) {
    throw new Error(`Not a directory: ${formatContainerWorkdir(relativeWorkdir)}`);
  }
  return target;
}

function buildUpdatedAgentWorkdir<T extends {
  runtimeConfig?: { workdir?: string; dirHistory?: string[] };
  updatedAt?: string;
}>(agent: T, relativeWorkdir: string): T {
  const history = [
    normalizeStoredWorkdir(relativeWorkdir),
    ...getAgentDirHistory(agent).filter((entry) => entry !== normalizeStoredWorkdir(relativeWorkdir)),
  ].slice(0, DIR_HISTORY_LIMIT);
  return {
    ...agent,
    runtimeConfig: {
      ...agent.runtimeConfig,
      workdir: normalizeStoredWorkdir(relativeWorkdir),
      dirHistory: history,
    },
    updatedAt: new Date().toISOString(),
  };
}

function formatDirStatus(agentId: string, agent?: { runtimeConfig?: { workdir?: string; dirHistory?: string[] } }): string {
  const history = getAgentDirHistory(agent);
  const lines = [
    `Current directory for ${agentId}: ${formatContainerWorkdir(agent?.runtimeConfig?.workdir)}`,
  ];
  if (history.length > 0) {
    lines.push(
      'Directory history:',
      ...history.map((entry, index) => `${index + 1}. ${formatContainerWorkdir(entry)}${index === 0 ? ' (current)' : ''}`),
    );
  }
  return lines.join('\n');
}

function getAgentCommands(agent?: { runtimeConfig?: { commands?: Record<string, string> } }): Record<string, string> {
  const value = agent?.runtimeConfig?.commands;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .map(([name, prompt]) => [name.toLowerCase(), prompt]),
  );
}

function getAgentAliases(agent?: { runtimeConfig?: { aliases?: Record<string, string> } }): Record<string, string> {
  const value = agent?.runtimeConfig?.aliases;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .map(([name, target]) => [name.toLowerCase(), target]),
  );
}

function normalizeCommandName(raw: string): string | null {
  const normalized = raw.trim().replace(/^\//, '').toLowerCase();
  return COMMAND_NAME_PATTERN.test(normalized) ? normalized : null;
}

function renderCommandTemplate(template: string, argsText: string): string {
  const args = tokenizeCommand(argsText);
  let rendered = template.replaceAll('{{args}}', argsText);
  rendered = rendered.replace(/\{\{arg(\d+)\}\}/gi, (_full, index) => {
    const value = args[Number(index) - 1];
    return typeof value === 'string' ? value : '';
  });
  return rendered.trim();
}

function formatCommandRegistry(
  title: string,
  entries: Record<string, string>,
  emptyText: string,
): string {
  const names = Object.keys(entries).sort();
  if (names.length === 0) return emptyText;
  return [
    `${title}:`,
    ...names.map((name) => `- /${name}: ${entries[name]}`),
  ].join('\n');
}

function splitRegistryDefinition(payload: string): { name: string; body: string } | null {
  const separator = payload.indexOf('::');
  if (separator < 0) return null;
  const name = payload.slice(0, separator).trim();
  const body = payload.slice(separator + 2).trim();
  if (!name || !body) return null;
  return { name, body };
}

function expandAliasInvocation(
  agent: { runtimeConfig?: { aliases?: Record<string, string> } },
  rawText: string,
  depth = 0,
): string {
  if (depth > 4) return rawText;
  const tokens = tokenizeCommand(rawText);
  const command = (tokens[0] || '').toLowerCase();
  if (!command.startsWith('/')) return rawText;
  const aliases = getAgentAliases(agent);
  const aliasTarget = aliases[command.slice(1)];
  if (!aliasTarget) return rawText;
  const argsText = tokens.slice(1).join(' ').trim();
  let expandedBase = aliasTarget.trim();
  if (!expandedBase.startsWith('/')) {
    expandedBase = `/${expandedBase}`;
  }
  const expanded = expandedBase.includes('{{args}}')
    ? renderCommandTemplate(expandedBase, argsText)
    : `${expandedBase}${argsText ? ` ${argsText}` : ''}`;
  return expandAliasInvocation(agent, expanded, depth + 1);
}

interface SkillRegistryEntry {
  id: string;
  description: string;
}

function getInstalledSkills(): SkillRegistryEntry[] {
  const skillsRoot = path.join(process.cwd(), 'container', 'skills');
  if (!fs.existsSync(skillsRoot)) return [];

  const skills: SkillRegistryEntry[] = [];
  for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;

    const skillFile = path.join(skillsRoot, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;

    try {
      const content = fs.readFileSync(skillFile, 'utf-8');
      const descriptionLine = content
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line && line !== '---' && !line.startsWith('#') && !/^name:\s*/i.test(line) && !/^description:\s*/i.test(line));
      skills.push({
        id: entry.name,
        description: descriptionLine || 'No description available.',
      });
    } catch {
      skills.push({
        id: entry.name,
        description: 'Failed to load description.',
      });
    }
  }

  return skills.sort((a, b) => a.id.localeCompare(b.id));
}

function getEnabledSkills(agent?: { runtimeConfig?: { enabledSkills?: string[] } }): string[] {
  return Array.from(
    new Set(
      (Array.isArray(agent?.runtimeConfig?.enabledSkills) ? agent.runtimeConfig.enabledSkills : [])
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ).sort();
}

function formatSkillsList(agent?: { runtimeConfig?: { enabledSkills?: string[] } }): string {
  const installed = getInstalledSkills();
  const enabled = new Set(getEnabledSkills(agent));
  if (installed.length === 0) return 'No installed skills found.';
  return [
    'Installed skills:',
    ...installed.map((skill) => `- ${skill.id}${enabled.has(skill.id) ? ' [enabled]' : ''}: ${skill.description}`),
  ].join('\n');
}

export function getStatusSnapshot(chatJid: string, deps: ControlPlaneDeps): Record<string, unknown> {
  const agentId = getAgentIdForChat(chatJid);
  const agent = agentId ? getAgentForChat(chatJid) : undefined;
  const workspaceFolder = getWorkspaceFolderForChat(chatJid);
  const provider = resolveProviderName(agent?.runtimeConfig?.provider);
  const model = resolveModelName(provider, agent?.runtimeConfig?.model);
  const tasks = getAllTasks().filter((task) => task.agent_id === agentId);
  return {
    assistant: ASSISTANT_NAME,
    chatJid,
    workspaceFolder,
    agentId,
    agentName: agent?.name,
    provider,
    model,
    currentDir: formatContainerWorkdir(agent?.runtimeConfig?.workdir),
    memoryConfigured: Boolean(agent?.systemPrompt),
    channels: deps.channels().map((channel) => ({
      name: channel.name,
      connected: channel.isConnected(),
    })),
    taskCount: tasks.length,
    tasks: tasks.map((task) => ({
      id: task.id,
      label: task.label || null,
      status: task.status,
      scheduleType: task.schedule_type,
      scheduleValue: task.schedule_value,
      nextRun: task.next_run,
    })),
  };
}

export function formatStatusSnapshot(snapshot: Record<string, unknown>): string {
  const channels = (snapshot.channels as Array<{ name: string; connected: boolean }> | undefined) || [];
  const tasks = (snapshot.tasks as Array<{ id: string; status: string; label?: string | null }> | undefined) || [];
  const lines = [
    `Chat: ${snapshot.chatJid || 'unknown'}`,
    `Workspace: ${snapshot.workspaceFolder || 'unknown'}`,
    `Agent: ${snapshot.agentId || 'unbound'}${snapshot.agentName ? ` (${snapshot.agentName})` : ''}`,
    `Provider: ${snapshot.provider || 'unknown'}`,
    `Model: ${snapshot.model || 'unknown'}`,
    `Directory: ${snapshot.currentDir || WORKSPACE_GROUP_ROOT}`,
    `Memory: ${snapshot.memoryConfigured ? 'configured' : 'empty'}`,
    `Channels: ${channels.map((channel) => `${channel.name}=${channel.connected ? 'up' : 'down'}`).join(', ') || 'none'}`,
    `Tasks: ${tasks.length}`,
  ];
  if (tasks.length > 0) {
    lines.push(...tasks.slice(0, 5).map((task) => `  - ${task.id} [${task.status}]${task.label ? ` ${task.label}` : ''}`));
  }
  return lines.join('\n');
}

export function getDoctorSnapshot(chatJid: string, deps: ControlPlaneDeps): Record<string, unknown> {
  const providerAvailability = getProviderAvailability();
  const workspaceFolder = getWorkspaceFolderForChat(chatJid);
  const agent = getAgentForChat(chatJid);
  const checks: Array<{ name: string; status: 'ok' | 'warn' | 'error'; detail: string }> = [];

  try {
    checkRuntime();
    checks.push({
      name: 'container-runtime',
      status: 'ok',
      detail: `${CONTAINER_RUNTIME} available (${CONTAINER_IMAGE})`,
    });
  } catch (err) {
    checks.push({
      name: 'container-runtime',
      status: 'error',
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  checks.push({
    name: 'workspace-folder',
    status: workspaceFolder ? 'ok' : 'error',
    detail: workspaceFolder
      ? path.join(GROUPS_DIR, workspaceFolder)
      : 'No workspace bound to current chat',
  });

  checks.push({
    name: 'provider-keys',
    status:
      providerAvailability.anthropic ||
      providerAvailability.openrouter ||
      providerAvailability.openaiCompatible
        ? 'ok'
        : 'error',
    detail: `anthropic=${providerAvailability.anthropic}, openrouter=${providerAvailability.openrouter}, openai-compatible=${providerAvailability.openaiCompatible}`,
  });

  checks.push({
    name: 'agent-memory',
    status: agent?.systemPrompt ? 'ok' : 'warn',
    detail: agent?.systemPrompt
      ? `Configured (${agent.systemPrompt.length} chars)`
      : 'No memory/system prompt configured for current agent',
  });

  if (workspaceFolder && agent) {
    try {
      ensureWorkspaceDirectoryExists(agent.workspaceFolder, normalizeStoredWorkdir(agent.runtimeConfig?.workdir));
      checks.push({
        name: 'working-directory',
        status: 'ok',
        detail: formatContainerWorkdir(agent.runtimeConfig?.workdir),
      });
    } catch (err) {
      checks.push({
        name: 'working-directory',
        status: 'error',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  checks.push({
    name: 'channels',
    status: deps.channels().some((channel) => channel.isConnected()) ? 'ok' : 'warn',
    detail: deps.channels()
      .map((channel) => `${channel.name}=${channel.isConnected() ? 'up' : 'down'}`)
      .join(', ') || 'No channels configured',
  });

  return {
    chatJid,
    workspaceFolder,
    runtime: CONTAINER_RUNTIME,
    checks,
  };
}

export function formatDoctorSnapshot(snapshot: Record<string, unknown>): string {
  const checks = (snapshot.checks as Array<{ name: string; status: string; detail: string }> | undefined) || [];
  return [
    `Doctor report for ${snapshot.chatJid || 'unknown'}`,
    `Runtime: ${snapshot.runtime || 'unknown'}`,
    ...checks.map((check) => `- [${check.status}] ${check.name}: ${check.detail}`),
  ].join('\n');
}

function formatProviderList(currentProvider: string, currentModel: string): string {
  const availability = getProviderAvailability();
  const providers = [
    { name: 'anthropic', available: availability.anthropic },
    { name: 'openrouter', available: availability.openrouter },
    { name: 'openai-compatible', available: availability.openaiCompatible },
  ];

  return [
    `Current provider: ${currentProvider}`,
    `Current model: ${currentModel}`,
    'Available providers:',
    ...providers.map((provider) => `- ${provider.name}${provider.available ? '' : ' (missing credentials)'}`),
  ].join('\n');
}

function getTasksForAgent(agentId?: string): ScheduledTask[] {
  if (!agentId) return [];
  return getAllTasks().filter((task) => task.agent_id === agentId);
}

function buildHeartbeatPrompt(workspaceFolder: string): string {
  return [
    `Heartbeat for workspace ${workspaceFolder}.`,
    'Summarize current workspace status, recent outputs, blockers, and next suggested actions.',
    'Keep it concise and operational.',
  ].join(' ');
}

export async function executeControlCommand(
  chatJid: string,
  rawText: string,
  deps: ControlPlaneDeps,
): Promise<ControlCommandResult> {
  const trimmed = rawText.trim();
  if (!trimmed.startsWith('/')) return { handled: false };

  const boundAgent = getAgentForChat(chatJid);
  const expandedText = boundAgent ? expandAliasInvocation(boundAgent, trimmed) : trimmed;
  const tokens = tokenizeCommand(expandedText);
  const command = (tokens[0] || '').toLowerCase();
  const agent = getAgentForChat(chatJid);
  const agentId = getAgentIdForChat(chatJid);
  const workspaceFolder = getWorkspaceFolderForChat(chatJid);

  switch (command) {
    case '/help':
      return {
        handled: true,
        response: [
          'Available control commands:',
          '/status',
          '/doctor',
          '/models [list|<number>]',
          '/provider [list|switch <name>]',
          '/model [show|switch <name>]',
          '/memory [show|set <text>|clear]',
          '/dir [show|reset|-|<path>|<history-number>]',
          '/workspace [current|list|bind <workspace-folder>]',
          '/commands [list|add <name> :: <prompt>|show <name>|delete <name>|run <name> [args...]]',
          '/alias [list|add <name> :: <target>|show <name>|delete <name>]',
          '/skills [list|current|enable <skill...>|disable <skill...>|reset|show <skill>]',
          '/cron [list|add interval <minutes> <prompt>|add cron "<expr>" <prompt>|pause <id>|resume <id>|delete <id>]',
          '/heartbeat [status|start <minutes>|stop]',
          '/threads',
          '/new [title]',
          '/current',
          '/use <thread-id-or-title>',
          '/rename <new-title> OR /rename <thread-id-or-title> :: <new-title>',
          '/archive [thread-id-or-title]',
        ].join('\n'),
      };
    case '/status': {
      const snapshot = getStatusSnapshot(chatJid, deps);
      return { handled: true, response: formatStatusSnapshot(snapshot), data: snapshot };
    }
    case '/doctor': {
      const snapshot = getDoctorSnapshot(chatJid, deps);
      return { handled: true, response: formatDoctorSnapshot(snapshot), data: snapshot };
    }
    case '/models': {
      if (!agent || !agentId) {
        return { handled: true, response: 'No agent is bound to this chat.' };
      }
      const provider = resolveProviderName(agent.runtimeConfig?.provider);
      const currentModel = resolveModelName(provider, agent.runtimeConfig?.model);
      const arg = (tokens[1] || 'list').toLowerCase();

      // Model catalog — organized by speed tier
      const catalog: Array<{ id: string; label: string; tier: string }> = [
        { id: 'qwen/qwen3-next-80b-a3b-instruct', label: 'Qwen3-Next 80B', tier: '⚡ 快速 (<1s)' },
        { id: 'mistralai/mistral-small-3.1-24b-instruct-2503', label: 'Mistral Small 24B', tier: '⚡ 快速 (<1s)' },
        { id: 'stepfun-ai/step-3.5-flash', label: 'Step-3.5 Flash', tier: '⚡ 快速 (<1s)' },
        { id: 'qwen/qwen3.5-122b-a10b', label: 'Qwen3.5 122B', tier: '⚡ 快速 (<1s)' },
        { id: 'deepseek-ai/deepseek-v3.1', label: 'DeepSeek V3.1', tier: '🔧 中等 (~2s)' },
        { id: 'qwen/qwen3.5-397b-a17b', label: 'Qwen3.5 397B', tier: '🔧 中等 (~2s)' },
        { id: 'deepseek-ai/deepseek-v3.2', label: 'DeepSeek V3.2', tier: '💪 重型 (30s+)' },
        { id: 'qwen/qwen3-coder-480b-a35b-instruct', label: 'Qwen3-Coder 480B', tier: '💪 重型 (30s+)' },
        { id: 'nvidia/llama-3.1-nemotron-ultra-253b-v1', label: 'Nemotron 253B', tier: '💪 重型 (30s+)' },
      ];

      // Check if arg is a number (quick select)
      const num = parseInt(arg, 10);
      if (!isNaN(num) && num >= 1 && num <= catalog.length) {
        const selected = catalog[num - 1];
        const updated = {
          ...agent,
          runtimeConfig: { ...agent.runtimeConfig, model: selected.id },
          updatedAt: new Date().toISOString(),
        };
        upsertAgentDefinition(updated);
        return { handled: true, response: `✅ 已切换到 ${selected.label} (${selected.id})` };
      }

      // Default: show model list
      const lines: string[] = [
        `📋 可用模型（当前: ${currentModel}）`,
        '',
      ];
      let lastTier = '';
      catalog.forEach((m, i) => {
        if (m.tier !== lastTier) {
          lines.push(m.tier);
          lastTier = m.tier;
        }
        const marker = m.id === currentModel ? ' ← 当前' : '';
        lines.push(`  ${i + 1}. ${m.label}${marker}`);
      });
      lines.push('', '输入 /models <编号> 快速切换');
      return {
        handled: true,
        response: lines.join('\n'),
        data: { type: 'model_picker', currentModel, catalog: catalog.map(m => ({ id: m.id, label: m.label })) },
      };
    }
    case '/provider': {
      if (!agent || !agentId) {
        return { handled: true, response: 'No agent is bound to this chat.' };
      }
      const action = (tokens[1] || 'list').toLowerCase();
      const currentProvider = resolveProviderName(agent.runtimeConfig?.provider);
      const currentModel = resolveModelName(currentProvider, agent.runtimeConfig?.model);

      if (action === 'list' || action === 'show' || action === 'current') {
        return {
          handled: true,
          response: formatProviderList(currentProvider, currentModel),
        };
      }

      if (action === 'switch') {
        const target = (tokens[2] || '').toLowerCase() as 'anthropic' | 'openrouter' | 'openai-compatible';
        const availability = getProviderAvailability();
        if (!['anthropic', 'openrouter', 'openai-compatible'].includes(target)) {
          return { handled: true, response: 'Usage: /provider switch <anthropic|openrouter|openai-compatible>' };
        }
        const allowed = (
          (target === 'anthropic' && availability.anthropic) ||
          (target === 'openrouter' && availability.openrouter) ||
          (target === 'openai-compatible' && availability.openaiCompatible)
        );
        if (!allowed) {
          return { handled: true, response: `Provider ${target} is not available in the current environment.` };
        }
        const updated = {
          ...agent,
          runtimeConfig: {
            ...agent.runtimeConfig,
            provider: target,
          },
          updatedAt: new Date().toISOString(),
        };
        upsertAgentDefinition(updated);
        return {
          handled: true,
          response: `Switched provider for agent ${agentId} to ${target}.`,
        };
      }
      return { handled: true, response: 'Usage: /provider [list|switch <name>]' };
    }
    case '/model': {
      if (!agent || !agentId) {
        return { handled: true, response: 'No agent is bound to this chat.' };
      }
      const action = (tokens[1] || 'show').toLowerCase();
      const provider = resolveProviderName(agent.runtimeConfig?.provider);
      if (action === 'show' || action === 'current') {
        return {
          handled: true,
          response: `Current model: ${resolveModelName(provider, agent.runtimeConfig?.model)}`,
        };
      }
      if (action === 'switch') {
        const model = tokens.slice(2).join(' ').trim();
        if (!model) {
          return { handled: true, response: 'Usage: /model switch <model-name>' };
        }
        if (provider === 'anthropic') {
          return {
            handled: true,
            response: 'Per-agent model switching is currently only supported for openrouter and openai-compatible providers.',
          };
        }
        const updated = {
          ...agent,
          runtimeConfig: {
            ...agent.runtimeConfig,
            model,
          },
          updatedAt: new Date().toISOString(),
        };
        upsertAgentDefinition(updated);
        return { handled: true, response: `Switched model for agent ${agentId} to ${model}.` };
      }
      return { handled: true, response: 'Usage: /model [show|switch <model-name>]' };
    }
    case '/memory': {
      if (!agent || !agentId) {
        return { handled: true, response: 'No agent is bound to this chat.' };
      }
      const action = (tokens[1] || 'show').toLowerCase();
      if (action === 'show') {
        return {
          handled: true,
          response: agent.systemPrompt
            ? `Current memory for ${agentId}:\n\n${agent.systemPrompt}`
            : `No memory configured for ${agentId}.`,
        };
      }
      if (action === 'clear') {
        upsertAgentDefinition({
          ...agent,
          systemPrompt: undefined,
          updatedAt: new Date().toISOString(),
        });
        return { handled: true, response: `Cleared memory for agent ${agentId}.` };
      }
      if (action === 'set') {
        const memory = tokens.slice(2).join(' ').trim();
        if (!memory) {
          return { handled: true, response: 'Usage: /memory set <text>' };
        }
        upsertAgentDefinition({
          ...agent,
          systemPrompt: memory,
          updatedAt: new Date().toISOString(),
        });
        return { handled: true, response: `Updated memory for agent ${agentId}.` };
      }
      return { handled: true, response: 'Usage: /memory [show|set <text>|clear]' };
    }
    case '/dir': {
      if (!agent || !agentId) {
        return { handled: true, response: 'No agent is bound to this chat.' };
      }
      const currentRelative = normalizeStoredWorkdir(agent.runtimeConfig?.workdir);
      const history = getAgentDirHistory(agent);
      const argument = trimmed.replace(/^\/dir\b/i, '').trim();

      if (!argument || ['show', 'current', 'list', 'history'].includes(argument.toLowerCase())) {
        return {
          handled: true,
          response: formatDirStatus(agentId, agent),
        };
      }

      let targetRelative = currentRelative;
      if (argument === 'reset') {
        targetRelative = '.';
      } else if (argument === '-') {
        if (history.length < 2) {
          return {
            handled: true,
            response: `No previous directory for ${agentId}. Current directory: ${formatContainerWorkdir(currentRelative)}`,
          };
        }
        targetRelative = history[1]!;
      } else if (/^\d+$/.test(argument)) {
        const index = parseInt(argument, 10) - 1;
        if (index < 0 || index >= history.length) {
          return {
            handled: true,
            response: `History entry ${argument} does not exist.\n\n${formatDirStatus(agentId, agent)}`,
          };
        }
        targetRelative = history[index]!;
      } else {
        try {
          targetRelative = resolveRequestedWorkdir(argument, currentRelative);
        } catch (err) {
          return {
            handled: true,
            response: err instanceof Error ? err.message : String(err),
          };
        }
      }

      try {
        ensureWorkspaceDirectoryExists(agent.workspaceFolder, targetRelative);
      } catch (err) {
        return {
          handled: true,
          response: err instanceof Error ? err.message : String(err),
        };
      }

      upsertAgentDefinition(buildUpdatedAgentWorkdir(agent, targetRelative));
      return {
        handled: true,
        response: formatDirStatus(agentId, getAgentForChat(chatJid)),
      };
    }
    case '/workspace': {
      const action = (tokens[1] || 'current').toLowerCase();
      if (action === 'current') {
        return {
          handled: true,
          response: [
            `Chat: ${chatJid}`,
            `Workspace: ${workspaceFolder || 'unbound'}`,
            `Agent: ${agentId || 'unbound'}`,
          ].join('\n'),
        };
      }
      if (action === 'list') {
        return { handled: true, response: formatWorkspaceList() };
      }
      if (action === 'bind') {
        const targetWorkspace = tokens[2];
        if (!targetWorkspace) {
          return { handled: true, response: 'Usage: /workspace bind <workspace-folder>' };
        }
        const binding = bindChatToWorkspace(chatJid, targetWorkspace);
        if (!binding) {
          return { handled: true, response: `Unable to bind ${chatJid} to workspace ${targetWorkspace}.` };
        }
        return {
          handled: true,
          response: `Bound ${chatJid} to workspace ${binding.workspaceFolder} (default agent=${binding.agentId}).`,
        };
      }
      return { handled: true, response: 'Usage: /workspace [current|list|bind <workspace-folder>]' };
    }
    case '/commands': {
      if (!agent || !agentId) {
        return { handled: true, response: 'No agent is bound to this chat.' };
      }
      const action = (tokens[1] || 'list').toLowerCase();
      const commands = getAgentCommands(agent);

      if (action === 'list') {
        return {
          handled: true,
          response: formatCommandRegistry(
            `Custom commands for ${agentId}`,
            commands,
            `No custom commands configured for ${agentId}.`,
          ),
        };
      }

      if (action === 'show') {
        const name = normalizeCommandName(tokens[2] || '');
        if (!name) {
          return { handled: true, response: 'Usage: /commands show <name>' };
        }
        const template = commands[name];
        return {
          handled: true,
          response: template
            ? `/${name} => ${template}`
            : `Custom command not found: /${name}`,
        };
      }

      if (action === 'add') {
        const payload = expandedText.replace(/^\/commands\s+add\s+/i, '').trim();
        const definition = splitRegistryDefinition(payload);
        if (!definition) {
          return { handled: true, response: 'Usage: /commands add <name> :: <prompt-template>' };
        }
        const name = normalizeCommandName(definition.name);
        if (!name) {
          return { handled: true, response: 'Command names must match /^[a-z][a-z0-9_-]{0,31}$/.' };
        }
        if (RESERVED_COMMANDS.has(name)) {
          return { handled: true, response: `/${name} is reserved and cannot be overridden.` };
        }
        const nextCommands = {
          ...commands,
          [name]: definition.body,
        };
        upsertAgentDefinition({
          ...agent,
          runtimeConfig: {
            ...agent.runtimeConfig,
            commands: nextCommands,
          },
          updatedAt: new Date().toISOString(),
        });
        return {
          handled: true,
          response: `Saved custom command /${name} for ${agentId}.`,
        };
      }

      if (action === 'delete' || action === 'remove') {
        const name = normalizeCommandName(tokens[2] || '');
        if (!name) {
          return { handled: true, response: 'Usage: /commands delete <name>' };
        }
        if (!commands[name]) {
          return { handled: true, response: `Custom command not found: /${name}` };
        }
        const nextCommands = { ...commands };
        delete nextCommands[name];
        upsertAgentDefinition({
          ...agent,
          runtimeConfig: {
            ...agent.runtimeConfig,
            commands: nextCommands,
          },
          updatedAt: new Date().toISOString(),
        });
        return {
          handled: true,
          response: `Deleted custom command /${name}.`,
        };
      }

      if (action === 'run') {
        const name = normalizeCommandName(tokens[2] || '');
        if (!name) {
          return { handled: true, response: 'Usage: /commands run <name> [args...]' };
        }
        const template = commands[name];
        if (!template) {
          return { handled: true, response: `Custom command not found: /${name}` };
        }
        const argsText = tokens.slice(3).join(' ').trim();
        return {
          handled: true,
          response: `Running custom command /${name}.`,
          dispatchPrompt: renderCommandTemplate(template, argsText),
        };
      }

      return {
        handled: true,
        response: 'Usage: /commands [list|add <name> :: <prompt>|show <name>|delete <name>|run <name> [args...]]',
      };
    }
    case '/alias': {
      if (!agent || !agentId) {
        return { handled: true, response: 'No agent is bound to this chat.' };
      }
      const action = (tokens[1] || 'list').toLowerCase();
      const aliases = getAgentAliases(agent);

      if (action === 'list') {
        return {
          handled: true,
          response: formatCommandRegistry(
            `Aliases for ${agentId}`,
            aliases,
            `No aliases configured for ${agentId}.`,
          ),
        };
      }

      if (action === 'show') {
        const name = normalizeCommandName(tokens[2] || '');
        if (!name) {
          return { handled: true, response: 'Usage: /alias show <name>' };
        }
        const target = aliases[name];
        return {
          handled: true,
          response: target
            ? `/${name} => ${target}`
            : `Alias not found: /${name}`,
        };
      }

      if (action === 'add') {
        const payload = expandedText.replace(/^\/alias\s+add\s+/i, '').trim();
        const definition = splitRegistryDefinition(payload);
        if (!definition) {
          return { handled: true, response: 'Usage: /alias add <name> :: <target-command>' };
        }
        const name = normalizeCommandName(definition.name);
        if (!name) {
          return { handled: true, response: 'Alias names must match /^[a-z][a-z0-9_-]{0,31}$/.' };
        }
        if (RESERVED_COMMANDS.has(name)) {
          return { handled: true, response: `/${name} is reserved and cannot be replaced with an alias.` };
        }
        const nextAliases = {
          ...aliases,
          [name]: definition.body,
        };
        upsertAgentDefinition({
          ...agent,
          runtimeConfig: {
            ...agent.runtimeConfig,
            aliases: nextAliases,
          },
          updatedAt: new Date().toISOString(),
        });
        return {
          handled: true,
          response: `Saved alias /${name} for ${agentId}.`,
        };
      }

      if (action === 'delete' || action === 'remove') {
        const name = normalizeCommandName(tokens[2] || '');
        if (!name) {
          return { handled: true, response: 'Usage: /alias delete <name>' };
        }
        if (!aliases[name]) {
          return { handled: true, response: `Alias not found: /${name}` };
        }
        const nextAliases = { ...aliases };
        delete nextAliases[name];
        upsertAgentDefinition({
          ...agent,
          runtimeConfig: {
            ...agent.runtimeConfig,
            aliases: nextAliases,
          },
          updatedAt: new Date().toISOString(),
        });
        return {
          handled: true,
          response: `Deleted alias /${name}.`,
        };
      }

      return {
        handled: true,
        response: 'Usage: /alias [list|add <name> :: <target>|show <name>|delete <name>]',
      };
    }
    case '/skills': {
      if (!agent || !agentId) {
        return { handled: true, response: 'No agent is bound to this chat.' };
      }
      const action = (tokens[1] || 'list').toLowerCase();
      const installed = getInstalledSkills();
      const installedIds = new Set(installed.map((skill) => skill.id));
      const enabled = getEnabledSkills(agent);

      if (action === 'list') {
        return {
          handled: true,
          response: formatSkillsList(agent),
          data: {
            installed,
            enabled,
          },
        };
      }

      if (action === 'current') {
        return {
          handled: true,
          response: enabled.length > 0
            ? `Enabled skills for ${agentId}:\n${enabled.map((skill) => `- ${skill}`).join('\n')}`
            : `No preferred skills configured for ${agentId}.`,
        };
      }

      if (action === 'show') {
        const skillId = (tokens[2] || '').trim();
        if (!skillId) {
          return { handled: true, response: 'Usage: /skills show <skill-id>' };
        }
        const skill = installed.find((entry) => entry.id === skillId);
        return {
          handled: true,
          response: skill
            ? `${skill.id}: ${skill.description}${enabled.includes(skill.id) ? '\nStatus: enabled' : ''}`
            : `Skill not found: ${skillId}`,
        };
      }

      if (action === 'enable' || action === 'disable') {
        const requested = tokens.slice(2).map((token) => token.trim()).filter(Boolean);
        if (requested.length === 0) {
          return {
            handled: true,
            response: `Usage: /skills ${action} <skill-id> [skill-id...]`,
          };
        }
        const invalid = requested.filter((skillId) => !installedIds.has(skillId));
        if (invalid.length > 0) {
          return {
            handled: true,
            response: `Unknown skills: ${invalid.join(', ')}`,
          };
        }
        const nextEnabled = action === 'enable'
          ? Array.from(new Set([...enabled, ...requested])).sort()
          : enabled.filter((skillId) => !requested.includes(skillId));
        upsertAgentDefinition({
          ...agent,
          runtimeConfig: {
            ...agent.runtimeConfig,
            enabledSkills: nextEnabled,
          },
          updatedAt: new Date().toISOString(),
        });
        return {
          handled: true,
          response: nextEnabled.length > 0
            ? `Enabled skills for ${agentId}:\n${nextEnabled.map((skill) => `- ${skill}`).join('\n')}`
            : `No preferred skills configured for ${agentId}.`,
        };
      }

      if (action === 'reset' || action === 'clear') {
        upsertAgentDefinition({
          ...agent,
          runtimeConfig: {
            ...agent.runtimeConfig,
            enabledSkills: [],
          },
          updatedAt: new Date().toISOString(),
        });
        return {
          handled: true,
          response: `Cleared preferred skills for ${agentId}.`,
        };
      }

      return {
        handled: true,
        response: 'Usage: /skills [list|current|enable <skill...>|disable <skill...>|reset|show <skill>]',
      };
    }
    case '/cron': {
      const action = (tokens[1] || 'list').toLowerCase();
      const agentTasks = getTasksForAgent(agentId);
      if (action === 'list') {
        return {
          handled: true,
          response: agentTasks.length > 0
            ? ['Scheduled tasks:', ...agentTasks.map(formatTask)].join('\n')
            : 'No scheduled tasks for the current agent.',
          data: agentTasks,
        };
      }
      if (action === 'add') {
        if (!workspaceFolder || !agentId) {
          return { handled: true, response: 'Current chat is missing workspace or agent context.' };
        }
        const mode = (tokens[2] || '').toLowerCase();
        if (mode !== 'interval' && mode !== 'cron') {
          return {
            handled: true,
            response: 'Usage: /cron add interval <minutes> <prompt> OR /cron add cron "<expr>" <prompt>',
          };
        }
        const valueToken = tokens[3];
        const prompt = tokens.slice(4).join(' ').trim();
        if (!valueToken || !prompt) {
          return {
            handled: true,
            response: 'Usage: /cron add interval <minutes> <prompt> OR /cron add cron "<expr>" <prompt>',
          };
        }
        const scheduleType = mode === 'interval' ? 'interval' as const : 'cron' as const;
        const scheduleValue = scheduleType === 'interval'
          ? String(Math.max(1, parseInt(valueToken, 10)) * 60_000)
          : valueToken;
        let nextRun: string;
        try {
          nextRun = computeNextRun(scheduleType, scheduleValue);
        } catch (err) {
          return {
            handled: true,
            response: err instanceof Error ? err.message : String(err),
          };
        }
        const taskId = `task-${randomUUID().slice(0, 8)}`;
        createTask({
          id: taskId,
          group_folder: workspaceFolder,
          chat_jid: chatJid,
          agent_id: agentId,
          label: 'cron',
          prompt,
          schedule_type: scheduleType,
          schedule_value: scheduleValue,
          context_mode: 'group',
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        return {
          handled: true,
          response: `Created task ${taskId}. Next run: ${nextRun}`,
        };
      }
      if (['pause', 'resume', 'delete'].includes(action)) {
        const taskId = tokens[2];
        if (!taskId) {
          return { handled: true, response: `Usage: /cron ${action} <task-id>` };
        }
        const task = getTaskById(taskId);
        if (!task || task.agent_id !== agentId) {
          return { handled: true, response: `Task not found for current agent: ${taskId}` };
        }
        if (action === 'delete') {
          deleteTask(taskId);
          return { handled: true, response: `Deleted task ${taskId}.` };
        }
        updateTask(taskId, { status: action === 'pause' ? 'paused' : 'active' });
        return { handled: true, response: `${action === 'pause' ? 'Paused' : 'Resumed'} task ${taskId}.` };
      }
      return {
        handled: true,
        response: 'Usage: /cron [list|add interval <minutes> <prompt>|add cron "<expr>" <prompt>|pause <id>|resume <id>|delete <id>]',
      };
    }
    case '/heartbeat': {
      if (!workspaceFolder || !agentId) {
        return { handled: true, response: 'Current chat is missing workspace or agent context.' };
      }
      const action = (tokens[1] || 'status').toLowerCase();
      const heartbeatTaskId = `heartbeat-${agentId}`;
      const existing = getTaskById(heartbeatTaskId);
      if (action === 'status') {
        return {
          handled: true,
          response: existing
            ? `Heartbeat is ${existing.status} (${existing.schedule_type}=${existing.schedule_value}, next=${existing.next_run || 'n/a'}).`
            : 'Heartbeat is not configured for the current agent.',
        };
      }
      if (action === 'start') {
        const minutes = Math.max(1, parseInt(tokens[2] || '15', 10));
        const scheduleValue = String(minutes * 60_000);
        const nextRun = computeNextRun('interval', scheduleValue);
        if (existing) {
          deleteTask(existing.id);
        }
        createTask({
          id: heartbeatTaskId,
          group_folder: workspaceFolder,
          chat_jid: chatJid,
          agent_id: agentId,
          label: 'heartbeat',
          prompt: buildHeartbeatPrompt(workspaceFolder),
          schedule_type: 'interval',
          schedule_value: scheduleValue,
          context_mode: 'group',
          next_run: nextRun,
          status: 'active',
          created_at: existing?.created_at || new Date().toISOString(),
        });
        return {
          handled: true,
          response: `Heartbeat started for ${agentId} every ${minutes} minute(s).`,
        };
      }
      if (action === 'stop') {
        if (!existing) {
          return { handled: true, response: 'Heartbeat is not configured for the current agent.' };
        }
        deleteTask(existing.id);
        return { handled: true, response: `Stopped heartbeat for ${agentId}.` };
      }
      return { handled: true, response: 'Usage: /heartbeat [status|start <minutes>|stop]' };
    }
    case '/threads': {
      if (!chatJid.endsWith('@local.web')) {
        const activeAgentId = getAgentIdForChat(chatJid);
        const activeWorkspace = getWorkspaceFolderForChat(chatJid);
        const threads = listThreadsForChat(chatJid);
        return {
          handled: true,
          response: threads.length > 0
            ? [
                'Threads:',
                ...threads.map((thread) => {
                  const active = thread.agentId === activeAgentId && thread.workspaceFolder === activeWorkspace ? '*' : ' ';
                  return `${active} ${thread.id} | ${thread.title} | workspace=${thread.workspaceFolder}`;
                }),
              ].join('\n')
            : 'No threads found for this chat.',
          data: threads,
        };
      }

      const threads = deps.listThreads?.() || [];
      return {
        handled: true,
        response: threads.length > 0
          ? ['Threads:', ...threads.map((thread) => `- ${thread.chatJid} | ${thread.title} | workspace=${thread.workspaceFolder}`)].join('\n')
          : 'Thread management is only available on local web.',
        data: threads,
      };
    }
    case '/current': {
      if (chatJid.endsWith('@local.web')) {
        return {
          handled: true,
          response: `Current web thread: ${chatJid}`,
        };
      }
      const currentThread = getCurrentThreadForChat(chatJid);
      if (!currentThread) {
        return { handled: true, response: 'No active thread for this chat.' };
      }
      return {
        handled: true,
        response: [
          `Current thread: ${currentThread.title}`,
          `ID: ${currentThread.id}`,
          `Workspace: ${currentThread.workspaceFolder}`,
          `Agent: ${currentThread.agentId}`,
          `Directory: ${formatContainerWorkdir(agent?.runtimeConfig?.workdir)}`,
        ].join('\n'),
        data: currentThread,
      };
    }
    case '/new': {
      if (chatJid.endsWith('@local.web')) {
        if (!deps.createThread) {
          return { handled: true, response: 'Creating a new thread is not supported in this environment.' };
        }
        const title = tokens.slice(1).join(' ').trim();
        const thread = await deps.createThread(title);
        return {
          handled: true,
          response: `Created thread ${thread.title} (${thread.chatJid}) in workspace ${thread.workspaceFolder}.`,
          data: thread,
        };
      }

      const title = normalizeThreadTitle(tokens.slice(1).join(' '));
      const thread = createThreadForChat(chatJid, title);
      if (!thread) {
        return { handled: true, response: 'Failed to create a thread for the current chat.' };
      }
      switchChatToThread(chatJid, thread.id);
      touchCurrentThreadForChat(chatJid);
      return {
        handled: true,
        response: `Created and switched to thread ${thread.title} (${thread.id}) in workspace ${thread.workspaceFolder}.`,
        data: thread,
      };
    }
    case '/use':
    case '/switch': {
      if (chatJid.endsWith('@local.web')) {
        return { handled: true, response: 'Thread switching in local web is done from the thread list UI.' };
      }
      const query = tokens.slice(1).join(' ').trim();
      if (!query) {
        return { handled: true, response: 'Usage: /use <thread-id-or-title>' };
      }
      const match = findThreadMatch(chatJid, query);
      if (!match) {
        return { handled: true, response: `Thread not found: ${query}` };
      }
      const switched = switchChatToThread(chatJid, match.id);
      if (!switched) {
        return { handled: true, response: `Failed to switch to thread ${match.id}.` };
      }
      touchCurrentThreadForChat(chatJid);
      return {
        handled: true,
        response: `Switched to thread ${switched.title} (${switched.id}).`,
        data: switched,
      };
    }
    case '/rename': {
      if (chatJid.endsWith('@local.web')) {
        return { handled: true, response: 'Thread rename in local web is currently handled by the thread list UI.' };
      }
      const payload = trimmed.replace(/^\/rename\s+/i, '').trim();
      if (!payload) {
        return { handled: true, response: 'Usage: /rename <new-title> OR /rename <thread-id-or-title> :: <new-title>' };
      }
      let target = getCurrentThreadForChat(chatJid);
      let nextTitle = payload;
      if (payload.includes('::')) {
        const parts = payload.split('::');
        const query = parts.shift()?.trim() || '';
        nextTitle = parts.join('::').trim();
        target = findThreadMatch(chatJid, query);
      }
      nextTitle = normalizeThreadTitle(nextTitle);
      if (!target || !nextTitle) {
        return { handled: true, response: 'Usage: /rename <new-title> OR /rename <thread-id-or-title> :: <new-title>' };
      }
      const renamed = renameThreadForChat(chatJid, target.id, nextTitle);
      if (!renamed) {
        return { handled: true, response: `Failed to rename thread ${target.id}.` };
      }
      return {
        handled: true,
        response: `Renamed thread ${renamed.id} to ${renamed.title}.`,
        data: renamed,
      };
    }
    case '/archive': {
      if (chatJid.endsWith('@local.web')) {
        return { handled: true, response: 'Thread archive in local web is currently handled by the thread list UI.' };
      }
      const query = tokens.slice(1).join(' ').trim();
      const threads = listThreadsForChat(chatJid);
      if (threads.length <= 1) {
        return { handled: true, response: 'Cannot archive the last remaining thread for this chat.' };
      }
      const target = query ? findThreadMatch(chatJid, query) : getCurrentThreadForChat(chatJid);
      if (!target) {
        return { handled: true, response: query ? `Thread not found: ${query}` : 'No active thread to archive.' };
      }
      const archived = archiveThreadForChat(chatJid, target.id);
      if (!archived) {
        return { handled: true, response: `Failed to archive thread ${target.id}.` };
      }
      return {
        handled: true,
        response: archived.switchedTo
          ? `Archived thread ${archived.archivedThread.title} (${archived.archivedThread.id}) and switched to ${archived.switchedTo.title} (${archived.switchedTo.id}).`
          : `Archived thread ${archived.archivedThread.title} (${archived.archivedThread.id}).`,
        data: archived,
      };
    }
    default:
      if (agent) {
        const customCommandName = normalizeCommandName(command);
        const template = customCommandName ? getAgentCommands(agent)[customCommandName] : undefined;
        if (template) {
          const argsText = tokens.slice(1).join(' ').trim();
          return {
            handled: true,
            response: `Running custom command /${customCommandName}.`,
            dispatchPrompt: renderCommandTemplate(template, argsText),
          };
        }
      }
      return { handled: false };
  }
}

export function getManagementSnapshot(deps: ControlPlaneDeps): Record<string, unknown> {
  const groups = getRegisteredGroupsMap();
  const agents = Object.values(getAgentsMap()).filter((agent) => !agent.archived);
  const tasks = getAllTasks();
  return {
    threads: deps.listThreads?.() || [],
    agents: agents.map((agent) => ({
      id: agent.id,
      workspaceFolder: agent.workspaceFolder,
      name: agent.name,
      description: agent.description || null,
      runtimeConfig: agent.runtimeConfig || null,
      currentDir: formatContainerWorkdir(agent.runtimeConfig?.workdir),
      enabledSkills: getEnabledSkills(agent),
      memoryConfigured: Boolean(agent.systemPrompt),
      chatCount: getChatJidsForAgent(agent.id).length,
    })),
    workspaces: listWorkspaceFolders().map((workspaceFolder) => ({
      workspaceFolder,
      chats: getChatJidsForWorkspace(workspaceFolder),
      agentCount: agents.filter((agent) => agent.workspaceFolder === workspaceFolder).length,
    })),
    chats: Object.entries(groups).map(([jid, group]) => ({
      jid,
      name: group.name,
      folder: group.folder,
      workspaceFolder: group.workspaceFolder || group.folder,
      agentId: getAgentIdForChat(jid) || null,
    })),
    tasks: tasks.map((task) => ({
      id: task.id,
      label: task.label || null,
      groupFolder: task.group_folder,
      chatJid: task.chat_jid,
      agentId: task.agent_id || null,
      scheduleType: task.schedule_type,
      scheduleValue: task.schedule_value,
      nextRun: task.next_run,
      status: task.status,
    })),
    env: {
      runtime: CONTAINER_RUNTIME,
      image: CONTAINER_IMAGE,
      localWeb: ENABLE_LOCAL_WEB,
      wechat: ENABLE_WECHAT,
      whatsapp: ENABLE_WHATSAPP,
      qq: Boolean(QQ_APP_ID),
      feishu: Boolean(FEISHU_APP_ID),
      wecom: Boolean(process.env.WECOM_BOT_ID),
    },
  };
}

export function writeAgentMemoryFile(agentId: string, content: string): void {
  const memoryDir = path.join(GROUPS_DIR, 'global', 'agent-memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(path.join(memoryDir, `${agentId}.md`), content);
}
