import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const CV_DIR = join(homedir(), '.cv');
const CONFIG_PATH = join(CV_DIR, 'config');
const TOKEN_PATH = join(CV_DIR, 'token');
const KEY_PATH = join(CV_DIR, 'id_ed25519');
const PUBKEY_PATH = join(CV_DIR, 'id_ed25519.pub');

export { CV_DIR, CONFIG_PATH, TOKEN_PATH, KEY_PATH, PUBKEY_PATH };

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface CvConfig {
  user_id?: string;
  server_url?: string;
}

export async function ensureCvDir(): Promise<void> {
  if (!existsSync(CV_DIR)) {
    await mkdir(CV_DIR, { recursive: true, mode: 0o700 });
  }
}

export async function loadConfig(): Promise<CvConfig> {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw) as CvConfig;
  } catch {
    return {};
  }
}

export async function saveConfig(config: CvConfig): Promise<void> {
  await ensureCvDir();
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

export async function getServerUrl(): Promise<string> {
  if (process.env.CV_SERVER_URL) return process.env.CV_SERVER_URL;
  const config = await loadConfig();
  if (!config.server_url) {
    throw new Error('No server URL configured. Run "cv init --host <url>" or set CV_SERVER_URL.');
  }
  return config.server_url;
}

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

export async function loadToken(): Promise<string | null> {
  try {
    const raw = await readFile(TOKEN_PATH, 'utf-8');
    return raw.trim();
  } catch {
    return null;
  }
}

export async function saveToken(token: string): Promise<void> {
  await ensureCvDir();
  await writeFile(TOKEN_PATH, token + '\n', { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export async function loadPublicKey(): Promise<string> {
  try {
    const raw = await readFile(PUBKEY_PATH, 'utf-8');
    return raw.trim();
  } catch {
    throw new Error(`No public key found at ${PUBKEY_PATH}. Run "cv init" first.`);
  }
}

export async function loadPrivateKey(): Promise<string> {
  try {
    const raw = await readFile(KEY_PATH, 'utf-8');
    return raw.trim();
  } catch {
    throw new Error(`No private key found at ${KEY_PATH}. Run "cv init" first.`);
  }
}

// ---------------------------------------------------------------------------
// MCP Client
// ---------------------------------------------------------------------------

export interface McpClientOptions {
  /** If set, use this token instead of reading from ~/.cv/token */
  token?: string;
  /** If set, skip sending a token (for unauthenticated tool calls) */
  noAuth?: boolean;
}

/**
 * Create and connect an MCP client to the Clairvoyant server via HTTP.
 * The token is sent as an Authorization: Bearer header.
 */
export async function createMcpClient(opts: McpClientOptions = {}): Promise<Client> {
  let token = opts.token ?? null;
  if (!opts.noAuth && !token) {
    token = await loadToken();
  }

  const serverUrl = await getServerUrl();

  const headers: Record<string, string> = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const transport = new StreamableHTTPClientTransport(
    new URL(serverUrl),
    { requestInit: { headers } },
  );

  const client = new Client(
    { name: 'cv-cli', version: '0.1.0' },
  );

  await client.connect(transport);
  return client;
}

/**
 * Call a tool on the MCP server and return the parsed result.
 * Throws on error responses.
 */
export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const result = await client.callTool({ name, arguments: args });

  if (!result.content || !Array.isArray(result.content) || result.content.length === 0) {
    throw new Error('Empty response from server');
  }

  const first = result.content[0] as { type: string; text?: string };
  if (first.type !== 'text' || !first.text) {
    throw new Error('Unexpected response format');
  }

  const parsed = JSON.parse(first.text);

  if (result.isError) {
    throw new Error(parsed.error ?? 'Unknown server error');
  }

  return parsed;
}

/**
 * Helper: create client, call tool, close client, return result.
 */
export async function quickCall(
  name: string,
  args: Record<string, unknown> = {},
  opts: McpClientOptions = {},
): Promise<unknown> {
  const client = await createMcpClient(opts);
  try {
    return await callTool(client, name, args);
  } finally {
    await client.close();
  }
}
