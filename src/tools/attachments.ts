import pg from 'pg';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { extname, basename } from 'node:path';
import crypto from 'node:crypto';
import { insertAttachment, getTaskById } from '../db/queries.js';
import type { Attachment } from '../types.js';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ATTACHMENTS_DIR = process.env.ATTACHMENTS_DIR || '/data/attachments';

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
  '.log': 'text/plain',
};

function guessContentType(filename: string): string {
  const ext = extname(filename).toLowerCase();
  return CONTENT_TYPES[ext] || 'application/octet-stream';
}

export async function attachFile(
  client: pg.PoolClient,
  actorId: string,
  input: { task_id: string; file_path: string; description: string },
): Promise<{ attachment: Attachment }> {
  // Validate task exists
  const task = await getTaskById(client, input.task_id);
  if (!task) throw new Error(`Task not found: ${input.task_id}`);

  const fileStat = await stat(input.file_path);
  if (fileStat.size > MAX_FILE_SIZE) {
    throw new Error(`File exceeds 10MB limit (${fileStat.size} bytes)`);
  }
  if (!fileStat.isFile()) {
    throw new Error('Path is not a regular file');
  }

  const filename = basename(input.file_path);
  const contentType = guessContentType(filename);
  const ext = extname(filename);

  await mkdir(ATTACHMENTS_DIR, { recursive: true });
  const storageId = crypto.randomUUID();
  const storagePath = `${ATTACHMENTS_DIR}/${storageId}${ext}`;
  await copyFile(input.file_path, storagePath);

  // Insert metadata
  const attachment = await insertAttachment(client, {
    task_id: input.task_id,
    filename,
    content_type: contentType,
    size_bytes: fileStat.size,
    description: input.description,
    file_path: storagePath,
    created_by: actorId,
  });

  return { attachment };
}
