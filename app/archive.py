from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

ARCHIVE_ID_PATTERN = re.compile(r"^[0-9a-f]{32}$")


def _safe_title(title: str) -> str:
    value = re.sub(r"[^\w\-\u4e00-\u9fff ]+", "", title, flags=re.UNICODE).strip()
    return value[:80] or "未命名录音"


class ArchiveStore:
    def __init__(self, directory: Path) -> None:
        self.directory = directory
        self.directory.mkdir(parents=True, exist_ok=True)

    def create(self, text: str, title: str = "未命名录音", language: str | None = None) -> dict[str, Any]:
        archive_id = uuid4().hex
        created_at = datetime.now(timezone.utc).isoformat()
        safe_title = _safe_title(title)
        record = {
            "id": archive_id,
            "title": safe_title,
            "text": text.strip(),
            "language": language,
            "created_at": created_at,
        }
        (self.directory / f"{archive_id}.txt").write_text(record["text"] + "\n", encoding="utf-8")
        (self.directory / f"{archive_id}.json").write_text(
            json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        return record

    def list(self) -> list[dict[str, Any]]:
        records: list[dict[str, Any]] = []
        for path in self.directory.glob("*.json"):
            try:
                records.append(json.loads(path.read_text(encoding="utf-8")))
            except (OSError, json.JSONDecodeError):
                continue
        return sorted(records, key=lambda item: item.get("created_at", ""), reverse=True)

    def get(self, archive_id: str) -> dict[str, Any] | None:
        if not ARCHIVE_ID_PATTERN.fullmatch(archive_id):
            return None
        path = self.directory / f"{archive_id}.json"
        if not path.is_file():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None

    def text_path(self, archive_id: str) -> Path | None:
        if not ARCHIVE_ID_PATTERN.fullmatch(archive_id):
            return None
        path = self.directory / f"{archive_id}.txt"
        return path if path.is_file() else None
