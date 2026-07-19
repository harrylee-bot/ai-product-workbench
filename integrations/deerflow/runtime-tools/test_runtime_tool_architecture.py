from __future__ import annotations

import ast
import re
import unittest
from dataclasses import dataclass
from pathlib import Path


_RUNTIME_TOOLS_DIR = Path(__file__).resolve().parent
_PRODUCTION_ROOT = _RUNTIME_TOOLS_DIR / "deerflow_workbench_tools"

_FORBIDDEN_IMPORT_PREFIXES = frozenset({
    "aiomysql",
    "aiopg",
    "aioredis",
    "aiosqlite",
    "asyncpg",
    "cassandra",
    "cx_oracle",
    "databases",
    "dbm",
    "django.db",
    "duckdb",
    "elasticsearch",
    "firebase_admin",
    "google.cloud.bigquery",
    "google.cloud.firestore",
    "mariadb",
    "motor",
    "mysql",
    "mysqldb",
    "oracledb",
    "peewee",
    "pg8000",
    "prisma",
    "psycopg",
    "psycopg2",
    "pymongo",
    "pymssql",
    "pyodbc",
    "redis",
    "shelve",
    "sqlalchemy",
    "sqlite3",
    "sqlmodel",
    "supabase",
    "tortoise",
})
_FORBIDDEN_MODULE_TOKENS = frozenset({
    "dao",
    "database",
    "databases",
    "db",
    "orm",
    "persistence",
    "repositories",
    "repository",
})
_DATABASE_RECEIVER_TOKENS = _FORBIDDEN_MODULE_TOKENS | frozenset({"repo", "repos"})
_DATABASE_HANDLE_TOKENS = frozenset({
    "collection",
    "conn",
    "connection",
    "cursor",
    "engine",
    "session",
    "transaction",
})
_DATABASE_HANDLE_METHODS = frozenset({
    "acquire",
    "add",
    "add_all",
    "aggregate",
    "begin",
    "bulk_write",
    "commit",
    "connect",
    "cursor",
    "delete",
    "execute",
    "executemany",
    "fetch",
    "fetchall",
    "fetchmany",
    "fetchone",
    "find",
    "find_many",
    "find_one",
    "flush",
    "insert",
    "merge",
    "query",
    "refresh",
    "rollback",
    "save",
    "scalar",
    "scalars",
    "select",
    "transaction",
    "update",
    "upsert",
})


@dataclass(frozen=True, order=True)
class _Violation:
    filename: str
    line: int
    column: int
    message: str

    def render(self) -> str:
        return f"{self.filename}:{self.line}:{self.column}: {self.message}"


def _identifier_tokens(value: str) -> frozenset[str]:
    snake_case = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", value)
    return frozenset(
        token.lower()
        for token in re.split(r"[^A-Za-z0-9]+", snake_case)
        if token
    )


def _forbidden_import(value: str) -> bool:
    candidate = value.lstrip(".")
    normalized = candidate.lower()
    if any(
        normalized == prefix or normalized.startswith(f"{prefix}.")
        for prefix in _FORBIDDEN_IMPORT_PREFIXES
    ):
        return True
    return bool(_identifier_tokens(candidate) & _FORBIDDEN_MODULE_TOKENS)


def _attribute_parts(node: ast.AST) -> tuple[str, ...]:
    parts: list[str] = []
    current = node
    while isinstance(current, ast.Attribute):
        parts.append(current.attr)
        current = current.value
    if isinstance(current, ast.Name):
        parts.append(current.id)
    else:
        return ()
    return tuple(reversed(parts))


class _ArchitectureVisitor(ast.NodeVisitor):
    def __init__(self, filename: str) -> None:
        self.filename = filename
        self.import_module_aliases: set[str] = set()
        self.importlib_aliases: set[str] = {"importlib"}
        self.violations: list[_Violation] = []

    def _record(self, node: ast.AST, message: str) -> None:
        self.violations.append(_Violation(
            self.filename,
            getattr(node, "lineno", 1),
            getattr(node, "col_offset", 0) + 1,
            message,
        ))

    def visit_Import(self, node: ast.Import) -> None:  # noqa: N802
        for alias in node.names:
            if alias.name == "importlib":
                self.importlib_aliases.add(alias.asname or alias.name)
            if _forbidden_import(alias.name):
                self._record(node, f"forbidden database/repository import '{alias.name}'")
        self.generic_visit(node)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:  # noqa: N802
        module = node.module or ""
        display_module = f"{'.' * node.level}{module}"
        if node.level == 0 and module == "importlib":
            for alias in node.names:
                if alias.name == "import_module":
                    self.import_module_aliases.add(alias.asname or alias.name)
        if module and _forbidden_import(module):
            self._record(
                node,
                f"forbidden database/repository import '{display_module}'",
            )
        else:
            for alias in node.names:
                imported_name = f"{module}.{alias.name}" if module else alias.name
                if _forbidden_import(imported_name):
                    display_name = f"{'.' * node.level}{imported_name}"
                    self._record(
                        node,
                        f"forbidden database/repository import '{display_name}'",
                    )
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:  # noqa: N802
        parts = _attribute_parts(node.func)
        is_dynamic_import = (
            parts == ("__import__",)
            or (len(parts) == 1 and parts[0] in self.import_module_aliases)
            or (
                len(parts) == 2
                and parts[0] in self.importlib_aliases
                and parts[1] == "import_module"
            )
        )
        if is_dynamic_import and node.args:
            module_argument = node.args[0]
            if isinstance(module_argument, ast.Constant) and isinstance(module_argument.value, str):
                if _forbidden_import(module_argument.value):
                    self._record(
                        node,
                        f"forbidden dynamic database/repository import '{module_argument.value}'",
                    )

        if parts:
            call_name = ".".join(parts)
            terminal_tokens = _identifier_tokens(parts[-1])
            receiver_tokens = frozenset().union(*(
                _identifier_tokens(part) for part in parts[:-1]
            )) if len(parts) > 1 else frozenset()
            terminal = parts[-1].lower()
            if terminal_tokens & _DATABASE_RECEIVER_TOKENS:
                self._record(
                    node,
                    f"direct database/repository call '{call_name}'",
                )
            elif receiver_tokens & _DATABASE_RECEIVER_TOKENS:
                self._record(
                    node,
                    f"direct database/repository call '{call_name}'",
                )
            elif (
                receiver_tokens & _DATABASE_HANDLE_TOKENS
                and terminal in _DATABASE_HANDLE_METHODS
            ):
                self._record(
                    node,
                    f"direct database/repository call '{call_name}'",
                )
        self.generic_visit(node)


def _scan_source(source: str, filename: str = "<fixture>") -> list[_Violation]:
    tree = ast.parse(source, filename=filename)
    visitor = _ArchitectureVisitor(filename)
    visitor.visit(tree)
    return sorted(set(visitor.violations))


class RuntimeToolArchitectureTest(unittest.TestCase):
    def test_checker_rejects_database_and_repository_access(self) -> None:
        violations = _scan_source(
            """
import importlib
import importlib as loader
import psycopg as pg
from importlib import import_module as load_module
from product.services import RunRepository

def invoke(db, service):
    pg.connect("postgresql://localhost/workbench")
    db.execute("select 1")
    service.run_repository.save({"id": "run_1"})
    RunRepository()
    importlib.import_module("sqlalchemy.orm")
    loader.import_module("asyncpg")
    load_module("redis")
""",
        )
        rendered = "\n".join(violation.render() for violation in violations)

        self.assertIn("forbidden database/repository import 'psycopg'", rendered)
        self.assertIn(
            "forbidden database/repository import 'product.services.RunRepository'",
            rendered,
        )
        self.assertIn("direct database/repository call 'db.execute'", rendered)
        self.assertIn(
            "direct database/repository call 'service.run_repository.save'",
            rendered,
        )
        self.assertIn("direct database/repository call 'RunRepository'", rendered)
        self.assertIn(
            "forbidden dynamic database/repository import 'sqlalchemy.orm'",
            rendered,
        )
        self.assertIn(
            "forbidden dynamic database/repository import 'asyncpg'",
            rendered,
        )
        self.assertIn(
            "forbidden dynamic database/repository import 'redis'",
            rendered,
        )

    def test_checker_allows_standard_library_and_http_clients(self) -> None:
        violations = _scan_source(
            """
import hashlib
import http.client
import json
from pathlib import Path
from urllib.request import Request, build_opener

import aiohttp
import httpx
import requests

def fetch(endpoint, payload, session, http_connection):
    request = Request(endpoint, data=json.dumps(payload).encode("utf-8"))
    with build_opener().open(request) as response:
        first = response.read()
    second = requests.post(endpoint, json=payload)
    third = httpx.get(endpoint)
    fourth = session.post(endpoint, json=payload)
    http_connection.request("GET", endpoint)
    return hashlib.sha256(first + second.content + third.content + fourth).hexdigest()
""",
        )

        self.assertEqual(violations, [])

    def test_production_runtime_tools_do_not_access_database_or_repositories(self) -> None:
        production_files = sorted(_PRODUCTION_ROOT.rglob("*.py"))
        self.assertTrue(production_files, f"no production Python files found under {_PRODUCTION_ROOT}")

        violations: list[_Violation] = []
        for path in production_files:
            relative_path = path.relative_to(_RUNTIME_TOOLS_DIR).as_posix()
            violations.extend(_scan_source(path.read_text(encoding="utf-8"), relative_path))

        self.assertEqual(
            violations,
            [],
            "Agent runtime tools must use capability-scoped HTTP APIs instead of "
            "database drivers, ORM clients, or application repositories:\n"
            + "\n".join(violation.render() for violation in violations),
        )


if __name__ == "__main__":
    unittest.main()
