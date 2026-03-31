import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'));


// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const QL_DIR = join(homedir(), '.ql');
const CONFIG_PATH = join(QL_DIR, 'config');
const TOKEN_PATH = join(QL_DIR, 'token');
const KEY_PATH = join(QL_DIR, 'id_ed25519');
const PUBKEY_PATH = join(QL_DIR, 'id_ed25519.pub');

export { QL_DIR, CONFIG_PATH, TOKEN_PATH, KEY_PATH, PUBKEY_PATH };

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface QlConfig {
  user_id?: string;
  server_url?: string;
}

export async function ensureQlDir(): Promise<void> {
  if (!existsSync(QL_DIR)) {
    await mkdir(QL_DIR, { recursive: true, mode: 0o700 });
  }
}

export async function loadConfig(): Promise<QlConfig> {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw) as QlConfig;
  } catch {
    return {};
  }
}

export async function saveConfig(config: QlConfig): Promise<void> {
  await ensureQlDir();
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

export async function getServerUrl(): Promise<string> {
  if (process.env.QL_SERVER_URL) return process.env.QL_SERVER_URL;
  const config = await loadConfig();
  if (!config.server_url) {
    throw new Error('No server URL configured. Run "ql init --host <url>" or set QL_SERVER_URL.');
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
  await ensureQlDir();
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
    throw new Error(`No public key found at ${PUBKEY_PATH}. Run "ql init" first.`);
  }
}

export async function loadPrivateKey(): Promise<string> {
  try {
    const raw = await readFile(KEY_PATH, 'utf-8');
    return raw.trim();
  } catch {
    throw new Error(`No private key found at ${KEY_PATH}. Run "ql init" first.`);
  }
}

// ---------------------------------------------------------------------------
// MCP Client
// ---------------------------------------------------------------------------

export interface McpClientOptions {
  /** If set, use this token instead of reading from ~/.ql/token */
  token?: string;
}

/**
 * Create and connect an MCP client to the Quest Log server via HTTP.
 * The token is sent as an Authorization: Bearer header.
 */
export async function createMcpClient(opts: McpClientOptions = {}): Promise<Client> {
  const token = opts.token ?? await loadToken();

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
    { name: 'ql-cli', version: pkg.version },
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

// ---------------------------------------------------------------------------
// Admin REST API
// ---------------------------------------------------------------------------

/**
 * Get the base URL for REST APIs.
 * Derives from the MCP server URL (strips /mcp suffix).
 */
async function getBaseUrl(): Promise<string> {
  const serverUrl = await getServerUrl();
  return serverUrl.replace(/\/mcp$/, '');
}

/**
 * Call an admin REST endpoint.
 */
export async function adminCall(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const baseUrl = await getBaseUrl();
  const token = await loadToken();
  if (!token) {
    throw new Error('Authentication required. Run "ql auth login" first.');
  }

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  const res = await fetch(`${baseUrl}/admin${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json() as Record<string, unknown>;

  if (!res.ok) {
    throw new Error(data.error as string ?? `HTTP ${res.status}`);
  }

  return data;
}

// ---------------------------------------------------------------------------
// Auth REST API (unauthenticated endpoints)
// ---------------------------------------------------------------------------

/**
 * Call an auth REST endpoint. Does not require a token.
 */
export async function authCall(
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const baseUrl = await getBaseUrl();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  const res = await fetch(`${baseUrl}/auth${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json() as Record<string, unknown>;

  if (!res.ok) {
    throw new Error(data.error as string ?? `HTTP ${res.status}`);
  }

  return data;
}
