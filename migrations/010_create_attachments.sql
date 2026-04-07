CREATE TABLE attachments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       uuid NOT NULL REFERENCES tasks(id),
  filename      text NOT NULL,
  content_type  text NOT NULL,
  size_bytes    integer NOT NULL,
  description   text NOT NULL,
  file_path     text NOT NULL,
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_attachments_task_id ON attachments(task_id);
