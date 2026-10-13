"""Shared POSIX subprocess behavior, also used by macOS."""
import os
import signal
from pathlib import Path

executable_suffix = ""
font_family = None
theme = "clam"

def settings_path(home, environ):
    return Path(environ.get("XDG_CONFIG_HOME", home / ".config")) / "VideoToImage/settings.json"

def process_options():
    return {"start_new_session": True}

def stop_process(process, owned=True):
    def stop(sig):
        try:
            if owned:
                os.killpg(process.pid, sig)
            elif process.poll() is None:
                process.send_signal(sig)
        except (ProcessLookupError, PermissionError):
            pass
    stop(signal.SIGTERM)
    try:
        process.wait(timeout=2)
    except TimeoutError:
        pass
    except Exception:
        pass
    # A child can outlive a parent that has already exited.
    stop(signal.SIGKILL)
    try:
        process.wait(timeout=2)
    except Exception:
        pass

def wheel_units(delta):
    return -int(delta / 120) if abs(delta) >= 120 else (-1 if delta > 0 else 1 if delta < 0 else 0)

