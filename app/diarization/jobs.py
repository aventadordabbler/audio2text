"""Durable task metadata. Audio, features and results remain in meeting files."""
from datetime import datetime, timezone


class ProcessingJobs:
    def __init__(self, store):
        self.store = store

    def queue(self, meeting_id, retry=False):
        with self.store._connection() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT status FROM diarization_jobs WHERE meeting_id = ?", (meeting_id,)).fetchone()
            if row and not retry:
                return False
            if row and row["status"] in {"queued", "running"}:
                return False
            db.execute("""INSERT INTO diarization_jobs(meeting_id, status, updated_at)
                VALUES (?, 'queued', ?) ON CONFLICT(meeting_id) DO UPDATE
                SET status = 'queued', attempts = 0, error = '', updated_at = excluded.updated_at""",
                (meeting_id, datetime.now(timezone.utc).isoformat()))
            return True

    def set(self, meeting_id, status, error=""):
        with self.store._connection() as db:
            db.execute("""UPDATE diarization_jobs SET status = ?, error = ?, updated_at = ?,
                attempts = attempts + ? WHERE meeting_id = ?""",
                (status, error, datetime.now(timezone.utc).isoformat(), int(status == "running"), meeting_id))

    def recover(self):
        with self.store._connection() as db:
            db.execute("UPDATE diarization_jobs SET status = 'queued' WHERE status = 'running' AND attempts < 2")
            db.execute("""UPDATE diarization_jobs SET status = 'failed', error = '校正多次中断，请手动重试。'
                WHERE status = 'running' AND attempts >= 2""")
            # Recover an interruption between committing 'ended' and enqueueing its job.
            db.execute("""INSERT OR IGNORE INTO diarization_jobs(meeting_id, status, updated_at)
                SELECT id, 'queued', updated_at FROM meetings
                WHERE status = 'ended' AND text_path LIKE 'meetings/%'""")
            return [dict(row) for row in db.execute("SELECT * FROM diarization_jobs")]
