"""Report vulnerable pinned packages and newer pinned-source releases, optionally in a GitHub issue.

Packages are looked up in the OSV database. FFmpeg, x264, dav1d, zlib and the Python
distribution only have their versions compared: OSV does not track those builds.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import subprocess
import sys

TOOLS = Path(__file__).resolve().parent
LOCKS = [TOOLS / "requirements-runtime.lock",
         TOOLS.parents[1] / "path-analysis-tools" / "tools" / "requirements-runtime.lock"]
ISSUE_TITLE = "Video Tools dependency updates"
TIMEOUT = 60


def fetch(url: str, payload: dict | None = None) -> str:
    curl = "curl.exe" if sys.platform == "win32" else "curl"
    command = [curl, "--fail", "--location", "--silent", "--show-error", "--retry", "2", "--max-time", str(TIMEOUT),
               "--user-agent", "tool-utility-update-check"]
    if payload is not None:
        command += ["--header", "Content-Type: application/json", "--data", json.dumps(payload)]
    return subprocess.run([*command, url], check=True, capture_output=True, text=True, encoding="utf-8",
                          errors="replace").stdout


def parse_lock(text: str) -> dict[str, str]:
    return {name.lower(): version for name, version in re.findall(r"^([A-Za-z0-9_.-]+)==([^\s\;]+)", text, re.M)}


def version_key(version: str) -> tuple[int, ...]:
    return tuple(int(part) for part in version.split("."))


def newest(versions: list[str]) -> str | None:
    return max(versions, key=version_key, default=None)


def vulnerabilities(packages: dict[str, str]) -> list[str]:
    names = sorted(packages)
    queries = [{"package": {"name": name, "ecosystem": "PyPI"}, "version": packages[name]} for name in names]
    results = json.loads(fetch("https://api.osv.dev/v1/querybatch", {"queries": queries}))["results"]
    return [f"`{name}` {packages[name]}: " + ", ".join(sorted(item["id"] for item in result["vulns"]))
            for name, result in zip(names, results) if result.get("vulns")]


def source_updates(sources: dict, assets: dict) -> tuple[list[str], list[str]]:
    """Compare each pinned source with its upstream; one unreachable source must not hide the others."""
    ffmpeg_branch = sources["ffmpeg"]["version"].rsplit(".", 1)[0]

    def ffmpeg():
        return newest(re.findall(rf"ffmpeg-({re.escape(ffmpeg_branch)}\.\d+)\.tar\.xz", fetch("https://ffmpeg.org/releases/")))

    def dav1d():
        return newest(re.findall(r'href="(\d+\.\d+\.\d+)/"', fetch("https://downloads.videolan.org/pub/videolan/dav1d/")))

    def zlib():
        return newest(re.findall(r"zlib-(\d+\.\d+(?:\.\d+)?)\.tar\.gz", fetch("https://zlib.net/")))

    def x264():
        branch = json.loads(fetch("https://code.videolan.org/api/v4/projects/videolan%2Fx264/repository/branches/stable"))
        return branch["commit"]["id"]

    def python():
        release = json.loads(fetch("https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest"))
        branch = assets["python"].rsplit(".", 1)[0]
        return newest(re.findall(rf"cpython-({re.escape(branch)}\.\d+)\+", " ".join(asset["name"] for asset in release["assets"])))

    pinned = {"FFmpeg": sources["ffmpeg"]["version"], "dav1d": sources["dav1d"]["version"], "zlib": sources["zlib"]["version"],
              "x264 stable": sources["x264"]["version"].split()[-1], "Python": assets["python"]}
    checks = {"FFmpeg": ffmpeg, "dav1d": dav1d, "zlib": zlib, "x264 stable": x264, "Python": python}
    updates, failures = [], []
    for name, check in checks.items():
        try:
            latest = check()
            if latest is None:
                failures.append(f"{name}: 최신 버전을 찾지 못했습니다.")
            elif name == "x264 stable":
                if latest != pinned[name]:
                    updates.append(f"{name}: {pinned[name][:12]} → {latest[:12]}")
            elif version_key(latest) > version_key(pinned[name]):
                updates.append(f"{name}: {pinned[name]} → {latest}")
        except (OSError, ValueError, KeyError, subprocess.SubprocessError) as exc:
            failures.append(f"{name}: {exc}")
    return updates, failures


def report_body(vulnerable: list[str], updates: list[str], failures: list[str]) -> str:
    sections = [("취약점이 보고된 패키지", vulnerable), ("새 버전이 있는 고정 소스", updates), ("확인하지 못한 항목", failures)]
    body = ["주간 의존성 점검 결과입니다. 갱신 절차는 `video-tools/docs/runtime-management.md`를 참고하세요.", ""]
    for title, items in sections:
        if items:
            body += [f"## {title}", "", *[f"- {item}" for item in items], ""]
    return "\n".join(body)


def update_issue(body: str | None) -> None:
    """Keep one open issue: create or update it for findings, close it when everything is clean."""
    def gh(*args):
        return subprocess.run(["gh", *args], check=True, capture_output=True, text=True, encoding="utf-8").stdout

    found = json.loads(gh("issue", "list", "--state", "open", "--search", f'"{ISSUE_TITLE}" in:title', "--json", "number,title"))
    numbers = [str(item["number"]) for item in found if item["title"] == ISSUE_TITLE]
    if body is None:
        for number in numbers:
            gh("issue", "close", number, "--comment", "최근 점검에서 확인된 항목이 없습니다.")
    elif numbers:
        gh("issue", "edit", numbers[0], "--body", body)
    else:
        gh("issue", "create", "--title", ISSUE_TITLE, "--body", body)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lock", type=Path, action="append", help="Lock file to check instead of the tools' own")
    parser.add_argument("--issue", action="store_true", help="Create, update or close the tracking issue")
    args = parser.parse_args()
    packages: dict[str, str] = {}
    for lock in args.lock or LOCKS:
        if lock.is_file():
            packages.update(parse_lock(lock.read_text(encoding="utf-8")))
    failures: list[str] = []
    try:
        vulnerable = vulnerabilities(packages)
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as exc:
        vulnerable = []
        failures.append(f"OSV: {exc}")
    sources = json.loads((TOOLS / "ffmpeg-sources.json").read_text(encoding="utf-8"))["sources"]
    assets = json.loads((TOOLS / "runtime-assets.json").read_text(encoding="utf-8"))
    updates, source_failures = source_updates(sources, assets)
    failures += source_failures
    body = report_body(vulnerable, updates, failures) if vulnerable or updates or failures else None
    print(f"Checked {len(packages)} packages" if body is None else body)
    if args.issue:
        update_issue(body)
    return 0


if __name__ == "__main__":
    sys.exit(main())
