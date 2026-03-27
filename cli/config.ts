import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

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
  /** If set, pass CV_TOKEN="" to allow unauthenticated tool calls */
  noAuth?: boolean;
}

/**
 * Create and connect an MCP client to the Clairvoyant server.
 *
 * For v1, always uses stdio transport — spawns the server as a subprocess.
 * The token is passed via the CV_TOKEN environment variable.
 */
export async function createMcpClient(opts: McpClientOptions = {}): Promise<Client> {
  let token = opts.token ?? null;
  if (!opts.noAuth && !token) {
    token = await loadToken();
  }

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
  };

  if (token) {
    env.CV_TOKEN = token;
  } else {
    // Some tools (register_user, authenticate) don't require auth.
    // The server will error on tools that do require it.
    env.CV_TOKEN = '';
  }

  // Propagate DATABASE_URL and CV_JWT_SECRET from parent environment
  // (these should already be in process.env)

  const transport = new StdioClientTransport({
    command: process.execPath, // node or tsx
    args: [
      '--import', 'tsx/esm',
      new URL('../src/server.ts', import.meta.url).pathname,
    ],
    env,
    stderr: 'pipe',
  });

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
