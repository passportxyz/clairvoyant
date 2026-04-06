import { Router } from 'express';
import type { Request, Response } from 'express';
import pg from 'pg';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { requireAuth } from './middleware.js';
import { getAttachmentById } from './db/queries.js';

export function createAttachmentsRouter(pool: pg.Pool): Router {
  const router = Router();

  router.use(requireAuth);

  router.get('/:id', async (req: Request, res: Response) => {
    const attachmentId = req.params.id as string;
    const client = await pool.connect();
    try {
      const attachment = await getAttachmentById(client, attachmentId);
      if (!attachment) {
        res.status(404).json({ error: 'Attachment not found' });
        return;
      }

      // Verify file exists on disk
      try {
        await stat(attachment.file_path);
      } catch {
        res.status(404).json({ error: 'Attachment file missing from storage' });
        return;
      }

      res.setHeader('Content-Type', attachment.content_type);
      res.setHeader('Content-Disposition', `inline; filename="${attachment.filename}"`);
      res.setHeader('Content-Length', attachment.size_bytes);
      createReadStream(attachment.file_path).pipe(res);
    } finally {
      client.release();
    }
  });

  return router;
}
