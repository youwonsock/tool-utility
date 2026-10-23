"""Relocate the complete product, hide host tools, and run offline stdio proof.

macOS uses an inherited sandbox. Windows uses temporary, program-specific
firewall rules (administrator rights are needed on that validation machine).
No rules are installed by the product launchers or normal tools.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def ps_literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def powershell(code):
    executable = Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    encoded = base64.b64encode(code.encode("utf-16-le")).decode("ascii")
    return subprocess.run([str(executable), "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
                          check=True, capture_output=True, text=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    output = args.output.expanduser().resolve()
    if output == ROOT or output.is_relative_to(ROOT):
        raise ValueError("Use a new validation folder outside the original product.")
    destination = output / "이동 한글 도구" / "path-analysis-tools"
    if destination.exists():
        raise ValueError("Refusing to overwrite a previous relocated validation.")
    output.mkdir(parents=True, exist_ok=True)
    shutil.copytree(ROOT, destination, ignore=shutil.ignore_patterns(".build", "__pycache__", ".DS_Store", "*.egg-info"))
    native = "windows-x64/python/python.exe" if os.name == "nt" else "macos-arm64/python/bin/python3.14"
    python = destination / "portable" / native
    workspace = output / "작업 자료" / "새 경로"
    report_path = output / "stdio-smoke-report.json"
    command = [str(python), "-I", "-B", "-X", "utf8"]
    environment = {k: v for k, v in os.environ.items()
                   if k not in ("PYTHONHOME", "PYTHONPATH", "DYLD_LIBRARY_PATH", "DYLD_FALLBACK_LIBRARY_PATH")}
    environment["PATH"] = ""
    prefix, firewall_names = [], []
    blocked_source = False
    try:
        if sys.platform == "darwin":
            denied_paths = [ROOT, ROOT.parent / 'video-tools']
            policy = '(version 1) (allow default) (deny network*) ' + ' '.join(
                '(deny file-read* (subpath ' + json.dumps(str(path)) + '))' for path in denied_paths)
            prefix = ["/usr/bin/sandbox-exec", "-p", policy]
            network_control = "macOS sandbox-exec deny network*"
            # Both prohibited capabilities are probed before the smoke test.
            probe = ("import socket, errno; from pathlib import Path\n"
                     "with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as connection:\n"
                     " connection.settimeout(1)\n"
                     " assert connection.connect_ex(('127.0.0.1', 9)) in (errno.EPERM, errno.EACCES), 'Network connect was not denied'\n"
                     f"try:\n Path({str(ROOT / 'README.md')!r}).read_bytes()\nexcept PermissionError:\n pass\nelse:\n raise RuntimeError('Original product remains readable')\n")
            subprocess.run([*prefix, *command, "-c", probe], check=True, env=environment, cwd=output, capture_output=True)
            blocked_source = True
        elif os.name == "nt":
            network_control = "Windows Firewall inbound and outbound program block"
            token = "path-analysis-" + uuid.uuid4().hex
            for direction in ("Inbound", "Outbound"):
                name = token + "-" + direction.lower()
                # Record the exact name first so cleanup also covers uncertain outcomes.
                firewall_names.append(name)
                powershell("$ErrorActionPreference='Stop'; New-NetFirewallRule -Name " + ps_literal(name)
                           + " -DisplayName " + ps_literal(name) + " -Direction " + direction
                           + " -Program " + ps_literal(python) + " -Action Block -Profile Any | Out-Null; "
                           + "$rule=Get-NetFirewallRule -Name " + ps_literal(name)
                           + "; if($rule.Enabled -ne 'True' -or $rule.Action -ne 'Block'){throw 'Firewall rule inactive'}")
        else:
            raise RuntimeError("Native portable proof supports Windows x64 and macOS ARM64.")
        configured = subprocess.run([*prefix, *command, str(destination / "launch.py"), "configure", "--workspace", str(workspace)],
                                    check=True, capture_output=True, text=True, encoding="utf-8", env=environment, cwd=output)
        config = json.loads(configured.stdout)
        if Path(config["mcpServers"]["path-analysis-tools"]["command"]).resolve() != python.resolve():
            raise RuntimeError("Configuration still points to the original product")
        (output / "relocated-config.json").write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        subprocess.run([*prefix, *command, str(destination / "tools/verify_smoke.py"), "--workspace", str(workspace),
                        "--report", str(report_path)], check=True, env=environment, cwd=output, capture_output=True)
        result = json.loads(report_path.read_text(encoding="utf-8"))
        result.update(relocation="passed", unicode_and_spaces="passed", network_control=network_control,
                      original_product_read_denied=blocked_source, sibling_video_tools_read_denied=blocked_source, relocated_product=str(destination))
        if not Path(result["executable"]).resolve().is_relative_to(destination):
            raise RuntimeError("Smoke test escaped the relocated runtime")
        # Exercise the actual user launcher with an empty PATH as well.
        launcher = destination / ("run.bat" if os.name == "nt" else "run_mac.command")
        arguments = [str(launcher), "cli", "--workspace", str(workspace), "server_info"]
        # cmd /s /c needs one outer quote pair around a batch command that also
        # contains quoted paths; pass the native command line unchanged.
        launcher_command = (subprocess.list2cmdline([os.environ["ComSpec"]]) + ' /d /s /c "' + subprocess.list2cmdline(arguments) + '"'
                            if os.name == "nt" else [*prefix, *arguments])
        check = subprocess.run(launcher_command,
                               check=True, capture_output=True, text=True, encoding="utf-8", env=environment, cwd=output)
        if json.loads(check.stdout)["scene_io"]:
            raise RuntimeError("Unexpected scene I/O")
        result["user_launcher"] = "passed"
        report_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({key:value for key,value in result.items() if key != 'source_sha256'}, ensure_ascii=False, indent=2))
    finally:
        for name in firewall_names:
            powershell("$ErrorActionPreference='Stop'; Get-NetFirewallRule -Name " + ps_literal(name)
                       + " -ErrorAction SilentlyContinue | Remove-NetFirewallRule")


if __name__ == "__main__":
    main()
