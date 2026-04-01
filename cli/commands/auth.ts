import crypto from 'node:crypto';
import { access, cp, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { Command } from 'commander';
import {
  ensureQlDir,
  loadConfig,
  saveConfig,
  loadToken,
  loadPublicKey,
  loadPrivateKey,
  authCall,
  getServerUrl,
  KEY_PATH,
  PUBKEY_PATH,
  QL_DIR,
} from '../config.js';

// ---------------------------------------------------------------------------
// Helper: sign nonce with ed25519 private key
// ---------------------------------------------------------------------------

function signNonce(privateKeyPem: string, nonce: string): string {
  const keyObject = crypto.createPrivateKey(privateKeyPem);
  const signature = crypto.sign(null, Buffer.from(nonce, 'utf8'), keyObject);
  return signature.toString('base64');
}

// ---------------------------------------------------------------------------
// Helper: convert ed25519 public key to SSH format
// ---------------------------------------------------------------------------

function publicKeyToSSH(publicKeyPem: string): string {
  const keyObject = crypto.createPublicKey(publicKeyPem);
  const der = keyObject.export({ type: 'spki', format: 'der' });
  // DER for ed25519 spki: 12 bytes prefix + 32 bytes raw key
  const rawKey = der.subarray(12);

  // SSH wire format: uint32 len + "ssh-ed25519" + uint32 len + raw key
  const typeStr = 'ssh-ed25519';
  const typeLen = Buffer.alloc(4);
  typeLen.writeUInt32BE(typeStr.length);
  const keyLen = Buffer.alloc(4);
  keyLen.writeUInt32BE(rawKey.length);
  const blob = Buffer.concat([typeLen, Buffer.from(typeStr), keyLen, rawKey]);
  return `ssh-ed25519 ${blob.toString('base64')}`;
}

// ---------------------------------------------------------------------------
// Helper: authenticate (challenge/response) and save token
// ---------------------------------------------------------------------------

async function doLogin(userId: string, privateKeyPem: string): Promise<string> {
  // Step 1: Request challenge
  const challenge = await authCall('POST', '/challenge', {
    user_id: userId,
  }) as { nonce: string; expires_at: string };

  // Step 2: Sign the nonce
  const signature = signNonce(privateKeyPem, challenge.nonce);

  // Step 3: Verify signature and get token
  const verified = await authCall('POST', '/verify', {
    user_id: userId,
    nonce: challenge.nonce,
    signature,
  }) as { token: string };

  return verified.token;
}

// ---------------------------------------------------------------------------
// Helper: normalize host URL to MCP endpoint
// ---------------------------------------------------------------------------

function normalizeHost(host: string): string {
  // Strip trailing slash
  let url = host.replace(/\/+$/, '');
  // If they didn't include /mcp, add it
  if (!url.endsWith('/mcp')) {
    url += '/mcp';
  }
  return url;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export function registerAuthCommands(program: Command): void {
  // ── ql init ──────────────────────────────────────────────────

  program
    .command('init')
    .description('Initialize Quest Log: generate keypair and configure server host')
    .requiredOption('--host <url>', 'Quest Log server URL (e.g. https://quest-log.example.com)')
    .action(async (opts) => {
      await ensureQlDir();

      // Save server URL
      const serverUrl = normalizeHost(opts.host);
      const config = await loadConfig();
      config.server_url = serverUrl;
      await saveConfig(config);

      console.log(`Server: ${serverUrl}`);

      // Generate keypair
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });

      const sshPubKey = publicKeyToSSH(publicKey);

      await writeFile(KEY_PATH, privateKey, { mode: 0o600 });
      await writeFile(PUBKEY_PATH, sshPubKey + '\n', { mode: 0o644 });

      console.log(`Keypair generated:`);
      console.log(`  Private: ${KEY_PATH}`);
      console.log(`  Public:  ${PUBKEY_PATH}`);
      console.log();
      console.log(`Next: ql register --name "Your Name"`);
    });

  // ── ql register ──────────────────────────────────────────────

  program
    .command('register')
    .description('Register as a new user, or re-register a new key for an existing user')
    .requiredOption('--name <name>', 'Display name')
    .option('--user-id <id>', 'Existing user ID (re-register new key after revocation)')
    .action(async (opts) => {
      // CLI users always have keys (from ql init)
      const publicKey = await loadPublicKey();
      const privateKeyPem = await loadPrivateKey();

      const params: Record<string, string> = {
        name: opts.name,
        public_key: publicKey,
      };
      if (opts.userId) {
        params.user_id = opts.userId;
      }

      const result = await authCall('POST', '/register', params) as {
        user: { id: string; status: string };
        key?: { id: string; status: string };
        warning?: string;
      };

      const config = await loadConfig();
      config.user_id = result.user.id;
      await saveConfig(config);

      console.log(`Registered as: ${opts.name}`);
      console.log(`  User ID: ${result.user.id}`);
      console.log(`  Status:  ${result.user.status}`);
      if (result.key) {
        console.log(`  Key:     ${result.key.status}`);
      }

      if (result.warning) {
        console.log(`\n  ⚠ ${result.warning}`);
      }

      // Auto-login if auto-approved
      if (result.user.status === 'active' && result.key?.status === 'approved') {
        const { saveToken } = await import('../config.js');
        const token = await doLogin(result.user.id, privateKeyPem);
        await saveToken(token);

        console.log(`  Token: saved to ~/.ql/token`);
        console.log();
        console.log(`Next: ql install`);
      } else {
        console.log();
        console.log(`Next: Ask an admin to approve you: ql admin approve ${result.user.id}`);
      }
    });

  // ── ql auth ──────────────────────────────────────────────────

  const auth = program
    .command('auth')
    .description('Authentication commands');

  // ── ql auth login ────────────────────────────────────────────

  auth
    .command('login')
    .description('Authenticate via challenge/response')
    .action(async () => {
      const config = await loadConfig();
      if (!config.user_id) {
        console.error('Error: No user_id in config. Run "ql register" first.');
        process.exit(1);
      }

      const privateKeyPem = await loadPrivateKey();
      const { saveToken } = await import('../config.js');
      const token = await doLogin(config.user_id, privateKeyPem);
      await saveToken(token);

      console.log(`Authenticated successfully.`);
      console.log(`Token saved to ~/.ql/token`);
    });

  // ── ql auth status ───────────────────────────────────────────

  auth
    .command('status')
    .description('Show current auth status')
    .action(async () => {
      const config = await loadConfig();
      const token = await loadToken();

      console.log(`Config directory: ${QL_DIR}`);
      console.log(`Server: ${config.server_url ?? '(not configured)'}`);
      console.log(`User ID: ${config.user_id ?? '(not set)'}`);
      console.log(`Token: ${token ? 'present' : '(none)'}`);

      if (token) {
        try {
          const parts = token.split('.');
          const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
          console.log();
          console.log(`Token claims:`);
          console.log(`  sub:  ${payload.sub}`);
          console.log(`  name: ${payload.name}`);
          if (payload.exp) {
            const expDate = new Date(payload.exp * 1000);
            const now = new Date();
            const expired = expDate < now;
            console.log(`  exp:  ${expDate.toISOString()}${expired ? ' (EXPIRED)' : ''}`);
          }
        } catch {
          console.log(`  (could not decode token)`);
        }
      }
    });

  // ── ql install ───────────────────────────────────────────────

  program
    .command('install')
    .description('Ensure Quest Log MCP server + skill are both installed')
    .action(async () => {
      const config = await loadConfig();
      const token = await loadToken();
      const serverUrl = await getServerUrl();

      if (!token) {
        console.error('Error: No token found. Run "ql register" or "ql auth login" first.');
        process.exit(1);
      }

      const __dirname = dirname(fileURLToPath(import.meta.url));
      const skillSrc = join(__dirname, '..', '..', '..', 'skills', 'questlog');
      const skillDest = join(homedir(), '.claude', 'skills', 'questlog');

      // ── Check what's already installed ──────────────────────────
      let mcpInstalled = false;
      try {
        const out = execFileSync('claude', ['mcp', 'list'], { encoding: 'utf8' });
        mcpInstalled = out.includes('questlog');
      } catch {
        // claude CLI not available
      }

      let skillInstalled = false;
      try {
        await access(join(skillDest, 'SKILL.md'));
        skillInstalled = true;
      } catch {
        // skill not found
      }

      // ── Install MCP server if needed ────────────────────────────
      if (mcpInstalled) {
        console.log(`✓ MCP server already configured`);
      } else {
        try {
          execFileSync('claude', [
            'mcp', 'add', 'questlog',
            '--transport', 'http', serverUrl,
            '--', '--header', `Authorization: Bearer ${token}`,
          ], { stdio: 'inherit' });
          console.log();
          console.log(`✓ MCP server installed`);
        } catch {
          console.log(`✗ Could not run "claude mcp add". Add manually:`);
          console.log();
          const mcpConfig = {
            mcpServers: {
              'questlog': {
                url: serverUrl,
                headers: {
                  Authorization: `Bearer ${token}`,
                },
              },
            },
          };
          console.log(JSON.stringify(mcpConfig, null, 2));
        }
      }

      // ── Install skill if needed ─────────────────────────────────
      if (skillInstalled) {
        // Always re-copy to pick up updates
        try {
          await cp(skillSrc, skillDest, { recursive: true });
          console.log(`✓ Skill updated: ${skillDest}/`);
        } catch (err) {
          console.log(`✓ Skill already installed: ${skillDest}/`);
        }
      } else {
        try {
          await cp(skillSrc, skillDest, { recursive: true });
          console.log(`✓ Skill installed: ${skillDest}/`);
        } catch (err) {
          console.log(`✗ Could not install skill: ${err instanceof Error ? err.message : err}`);
        }
      }

      console.log();
      console.log(`  Server: ${serverUrl}`);
      console.log(`  User:   ${config.user_id ?? '(unknown)'}`);
    });

  // ── ql mcp-config ────────────────────────────────────────────

  program
    .command('mcp-config')
    .description('Print MCP config JSON snippet for use in agent config files')
    .action(async () => {
      const token = await loadToken();
      const serverUrl = await getServerUrl();

      const config = {
        mcpServers: {
          'questlog': {
            url: serverUrl,
            headers: {
              Authorization: `Bearer ${token ?? '<your-token-here>'}`,
            },
          },
        },
      };

      console.log(JSON.stringify(config, null, 2));
    });
}
