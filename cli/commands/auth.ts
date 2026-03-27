import crypto from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { Command } from 'commander';
import {
  ensureCvDir,
  loadConfig,
  saveConfig,
  loadToken,
  loadPublicKey,
  loadPrivateKey,
  quickCall,
  KEY_PATH,
  PUBKEY_PATH,
  CV_DIR,
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
  const challenge = await quickCall('authenticate', {
    user_id: userId,
    action: 'request_challenge',
  }, { noAuth: true }) as { nonce: string; expires_at: string };

  // Step 2: Sign the nonce
  const signature = signNonce(privateKeyPem, challenge.nonce);

  // Step 3: Verify signature and get token
  const verified = await quickCall('authenticate', {
    user_id: userId,
    action: 'verify',
    nonce: challenge.nonce,
    signature,
  }, { noAuth: true }) as { token: string };

  return verified.token;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export function registerAuthCommands(program: Command): void {
  // ── cv init ──────────────────────────────────────────────────

  program
    .command('init')
    .description('Generate ed25519 keypair at ~/.cv/')
    .action(async () => {
      await ensureCvDir();

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
      console.log(`Public key:`);
      console.log(`  ${sshPubKey}`);
    });

  // ── cv register ──────────────────────────────────────────────

  program
    .command('register')
    .description('Register as a new user and authenticate')
    .requiredOption('--name <name>', 'Display name')
    .action(async (opts) => {
      const publicKey = await loadPublicKey();
      const privateKeyPem = await loadPrivateKey();

      const result = await quickCall('register_user', {
        name: opts.name,
        public_key: publicKey,
      }, { noAuth: true }) as { user: { id: string } };

      const config = await loadConfig();
      config.user_id = result.user.id;
      await saveConfig(config);

      console.log(`Registered as: ${opts.name}`);
      console.log(`  User ID: ${result.user.id}`);

      // Automatically authenticate after registration
      const { saveToken } = await import('../config.js');
      const token = await doLogin(result.user.id, privateKeyPem);
      await saveToken(token);

      console.log(`  Token: saved to ~/.cv/token`);
    });

  // ── cv auth ──────────────────────────────────────────────────

  const auth = program
    .command('auth')
    .description('Authentication commands');

  // ── cv auth login ────────────────────────────────────────────

  auth
    .command('login')
    .description('Authenticate via challenge/response')
    .action(async () => {
      const config = await loadConfig();
      if (!config.user_id) {
        console.error('Error: No user_id in config. Run "cv register" first.');
        process.exit(1);
      }

      const privateKeyPem = await loadPrivateKey();
      const { saveToken } = await import('../config.js');
      const token = await doLogin(config.user_id, privateKeyPem);
      await saveToken(token);

      console.log(`Authenticated successfully.`);
      console.log(`Token saved to ~/.cv/token`);
    });

  // ── cv auth status ───────────────────────────────────────────

  auth
    .command('status')
    .description('Show current auth status')
    .action(async () => {
      const config = await loadConfig();
      const token = await loadToken();

      console.log(`Config directory: ${CV_DIR}`);
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

  // ── cv mcp-config ────────────────────────────────────────────

  program
    .command('mcp-config')
    .description('Print MCP config JSON snippet for use in agent config files')
    .action(async () => {
      const token = await loadToken();

      const config = {
        mcpServers: {
          clairvoyant: {
            command: 'npx',
            args: ['tsx', 'src/server.ts'],
            env: {
              CV_TOKEN: token ?? '<your-token-here>',
            },
          },
        },
      };

      console.log(JSON.stringify(config, null, 2));
    });
}
