from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import secrets
import sqlite3
from typing import Any
from uuid import uuid4

from .meetings import MeetingError, _timestamp

SESSION_HOURS = 6
PASSWORD_ITERATIONS = 210_000


def _password_digest(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PASSWORD_ITERATIONS)
    return f"{PASSWORD_ITERATIONS}${salt.hex()}${digest.hex()}"


def _verify_password(password: str, encoded: str) -> bool:
    try:
        iterations, salt, expected = encoded.split("$", 2)
        actual = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), int(iterations))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual.hex(), expected)


class AuthStore:
    def __init__(self, path):
        self.path = path
        with self._connection() as db:
            if "must_change_password" not in {row["name"] for row in db.execute("PRAGMA table_info(users)")}:
                db.execute("ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0")

    def _connection(self):
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        return db

    @staticmethod
    def _user(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "account": row["account"],
            "employee_id": row["employee_id"],
            "department_id": row["department_id"],
            "department_name": row["department_name"],
            "is_admin": row["account"].casefold() == "admin",
            "must_change_password": bool(row["must_change_password"]),
        }

    def ensure_admin(self) -> None:
        db = self._connection()
        try:
            with db:
                db.execute("BEGIN IMMEDIATE")
                if db.execute("SELECT 1 FROM users WHERE account = ? COLLATE NOCASE", ("admin",)).fetchone():
                    return
                department = db.execute("SELECT id FROM departments WHERE name = ? COLLATE NOCASE", ("管理员",)).fetchone()
                department_id = department["id"] if department else uuid4().hex
                if department is None:
                    now = _timestamp()
                    db.execute("INSERT INTO departments (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
                               (department_id, "管理员", now, now))
                db.execute("""INSERT INTO users
                    (id, account, password_hash, department_id, employee_id, created_at, must_change_password)
                    VALUES (?, ?, ?, ?, ?, ?, 1)""",
                           (uuid4().hex, "admin", _password_digest(""), department_id, "admin", _timestamp()))
        finally:
            db.close()

    def register(self, account: str, password: str, department: str, employee_id: str) -> dict[str, Any]:
        account, department, employee_id = account.strip(), department.strip(), employee_id.strip()
        if not account or len(account) > 60:
            raise MeetingError("账号须为 1–60 个字符", 422)
        if len(password) < 8 or len(password) > 128:
            raise MeetingError("密码须为 8–128 个字符", 422)
        if not department or len(department) > 60:
            raise MeetingError("部门须为 1–60 个字符", 422)
        if not employee_id or len(employee_id) > 60:
            raise MeetingError("工号须为 1–60 个字符", 422)
        db = self._connection()
        try:
            with db:
                db.execute("BEGIN IMMEDIATE")
                if db.execute("SELECT 1 FROM users WHERE account = ? COLLATE NOCASE", (account,)).fetchone():
                    raise MeetingError("账号已存在", 409)
                department_row = db.execute("SELECT id FROM departments WHERE name = ? COLLATE NOCASE", (department,)).fetchone()
                if department_row is None:
                    department_id = uuid4().hex
                    now = _timestamp()
                    db.execute("INSERT INTO departments (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
                               (department_id, department, now, now))
                else:
                    department_id = department_row["id"]
                user_id = uuid4().hex
                db.execute("""INSERT INTO users (id, account, password_hash, department_id, employee_id, created_at)
                    VALUES (?, ?, ?, ?, ?, ?)""",
                           (user_id, account, _password_digest(password), department_id, employee_id, _timestamp()))
                row = db.execute("""SELECT users.*, departments.name AS department_name FROM users
                    JOIN departments ON departments.id = users.department_id WHERE users.id = ?""", (user_id,)).fetchone()
                return self._user(row)
        except sqlite3.IntegrityError as exc:
            raise MeetingError("账号或工号已存在", 409) from exc
        finally:
            db.close()

    def login(self, account: str, password: str) -> tuple[str, str, dict[str, Any]]:
        db = self._connection()
        try:
            row = db.execute("""SELECT users.*, departments.name AS department_name FROM users
                JOIN departments ON departments.id = users.department_id WHERE users.account = ? COLLATE NOCASE""", (account.strip(),)).fetchone()
            if row is None or not _verify_password(password, row["password_hash"]):
                raise MeetingError("账户不存在或密码错误", 401)
            token = secrets.token_urlsafe(32)
            expires = datetime.now(timezone.utc) + timedelta(hours=SESSION_HOURS)
            token_hash = hashlib.sha256(token.encode()).hexdigest()
            with db:
                db.execute("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
                           (token_hash, row["id"], expires.isoformat(), _timestamp()))
            return token, expires.isoformat(), self._user(row)
        finally:
            db.close()

    def change_password(self, user_id: str, password: str) -> dict[str, Any]:
        if len(password) < 8 or len(password) > 128:
            raise MeetingError("密码须为 8–128 个字符", 422)
        db = self._connection()
        try:
            with db:
                db.execute("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?",
                           (_password_digest(password), user_id))
                row = db.execute("""SELECT users.*, departments.name AS department_name FROM users
                    JOIN departments ON departments.id = users.department_id WHERE users.id = ?""", (user_id,)).fetchone()
                if row is None:
                    raise MeetingError("账户不存在", 401)
                return self._user(row)
        finally:
            db.close()

    def user_for_token(self, token: str | None) -> dict[str, Any] | None:
        if not token:
            return None
        db = self._connection()
        try:
            row = db.execute("""SELECT users.*, departments.name AS department_name, sessions.expires_at
                FROM sessions JOIN users ON users.id = sessions.user_id
                JOIN departments ON departments.id = users.department_id
                WHERE sessions.token_hash = ?""", (hashlib.sha256(token.encode()).hexdigest(),)).fetchone()
            if row is None or datetime.fromisoformat(row["expires_at"]) <= datetime.now(timezone.utc):
                if row is not None:
                    with db:
                        db.execute("DELETE FROM sessions WHERE token_hash = ?", (hashlib.sha256(token.encode()).hexdigest(),))
                return None
            return self._user(row)
        finally:
            db.close()

    def logout(self, token: str | None) -> None:
        if not token:
            return
        db = self._connection()
        try:
            with db:
                db.execute("DELETE FROM sessions WHERE token_hash = ?", (hashlib.sha256(token.encode()).hexdigest(),))
        finally:
            db.close()
