"""Windows presentation and owned subprocess-tree termination."""
import subprocess
import os
from pathlib import Path

executable_suffix = ".exe"
font_family = "Segoe UI"
theme = "vista"

def settings_path(home, environ):
    return Path(environ.get("APPDATA", home / "AppData/Roaming")) / "VideoToImage/settings.json"

def process_options():
    return {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)}

def stop_process(process, owned=True):
    if process.poll() is None:
        try:
            subprocess.run([str(Path(os.environ["SystemRoot"]) / "System32/taskkill.exe"), "/PID", str(process.pid), "/T", "/F"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), timeout=5, check=False)
        except (OSError, subprocess.TimeoutExpired):
            process.terminate()
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=2)

def wheel_units(delta):
    return -int(delta / 120)

def bind_precise_scroll(root, tag, canvas):
    pass

def install_quit_handler(root, callback):
    pass

