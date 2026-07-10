from __future__ import annotations

import json
import os
import time
from pathlib import Path


class CollectorBusyError(RuntimeError):
    pass


class FileLock:
    def __init__(self, path: Path, stale_seconds: int = 300):
        self.path = path
        self.stale_seconds = max(30, int(stale_seconds))
        self.acquired = False

    def __enter__(self):
        self.acquire()
        return self

    def __exit__(self, exc_type, exc, tb):
        self.release()

    def acquire(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        for attempt in range(2):
            try:
                fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    json.dump({"pid": os.getpid(), "created_at_epoch": time.time()}, handle)
                self.acquired = True
                return
            except FileExistsError:
                try:
                    age = time.time() - self.path.stat().st_mtime
                except OSError:
                    age = 0
                if age > self.stale_seconds and attempt == 0:
                    try:
                        self.path.unlink()
                        continue
                    except OSError:
                        pass
                raise CollectorBusyError(
                    f"Já existe uma coleta em execução ou lock recente: {self.path}"
                )

    def release(self) -> None:
        if self.acquired:
            try:
                self.path.unlink(missing_ok=True)
            finally:
                self.acquired = False
