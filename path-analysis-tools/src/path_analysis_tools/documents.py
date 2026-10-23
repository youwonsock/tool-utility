"""Versioned validation, canonical fingerprints and atomic workspace artifacts."""
from __future__ import annotations

import hashlib
import json
import math
import os
import tempfile
from pathlib import Path

from jsonschema import Draft202012Validator

from .schema_catalog import SCHEMAS


class ContractError(ValueError):
    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message)


def fail(code, message):
    raise ContractError(code, message)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def fingerprint(value):
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def _finite(value):
    if isinstance(value, float) and not math.isfinite(value):
        fail("NON_FINITE", "NaN and infinity are not valid document values.")
    if isinstance(value, dict):
        for item in value.values():
            _finite(item)
    elif isinstance(value, list):
        for item in value:
            _finite(item)


def validate(value, kind=None):
    if not isinstance(value, dict):
        fail("INVALID_DOCUMENT", "A JSON object is required.")
    name = kind or value.get("document_type")
    if name not in SCHEMAS:
        fail("UNKNOWN_DOCUMENT", f"Unknown document type: {name!r}")
    _finite(value)
    error = next(Draft202012Validator(SCHEMAS[name]).iter_errors(value), None)
    if error:
        location = ".".join(str(p) for p in error.absolute_path) or "$"
        fail("SCHEMA_ERROR", f"{name}.{location}: {error.message}")
    return value


def unique(items, label):
    if len(items) != len(set(items)):
        fail("DUPLICATE_ID", f"Duplicate {label}.")


def loads(text):
    def reject(value):
        fail("NON_FINITE", f"Invalid JSON number: {value}")
    def pairs(values):
        result = {}
        for key, value in values:
            if key in result:
                fail("DUPLICATE_KEY", f"Duplicate JSON key: {key}")
            result[key] = value
        return result
    return json.loads(text, parse_constant=reject, object_pairs_hook=pairs)


def load(path):
    return loads(Path(path).read_text(encoding="utf-8"))


class Workspace:
    def __init__(self, root):
        self.root = Path(root).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def resolve(self, path, existing=False):
        candidate = Path(path).expanduser()
        resolved = (candidate if candidate.is_absolute() else self.root / candidate).resolve()
        if not resolved.is_relative_to(self.root):
            fail("OUTSIDE_WORKSPACE", "Input and output paths must remain inside --workspace.")
        if existing and not resolved.is_file():
            fail("FILE_NOT_FOUND", str(path))
        return resolved

    def relative(self, path):
        return self.resolve(path).relative_to(self.root).as_posix()

    def write(self, path, value):
        destination = self.resolve(path)
        destination.parent.mkdir(parents=True, exist_ok=True)
        # Resolve again after making parents; never follow an outside workspace symlink.
        destination = self.resolve(path)
        data = (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")
        descriptor, temporary = tempfile.mkstemp(prefix=".path-analysis-", dir=destination.parent)
        try:
            with os.fdopen(descriptor, "wb") as output:
                output.write(data)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, destination)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        return self.relative(destination)
