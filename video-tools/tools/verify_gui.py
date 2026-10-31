"""Drive the real GUI window through its widgets; file and message dialogs are stubbed."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import tkinter as tk

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.dont_write_bytecode = True
for name in ("TCL_LIBRARY", "TK_LIBRARY"):
    os.environ.pop(name, None)

from video_tools.core.backend import probe_image, probe_video
from video_tools.gui import app as gui
from video_tools.runtime import bundled_ffmpeg, require_runtime

ffmpeg = str(bundled_ffmpeg())
dialogs: list[tuple[str, str]] = []
callback_errors: list[str] = []
results: list[tuple[str, bool]] = []


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print("PASS" if ok else "FAIL", name, detail, flush=True)


def pump(window, until, seconds=120):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        window.update()
        if until():
            return True
        time.sleep(.02)
    return False


def choose(window, path):
    gui.filedialog.askopenfilename = lambda **_: str(path)
    window.video_button.invoke()
    return pump(window, lambda: window.duration is not None and str(window.start_button.cget("state")) == "normal", 60)


def run(window):
    dialogs.clear()
    window.start_button.invoke()
    window.update()
    done = pump(window, lambda: not window.current_job)
    return dialogs[-1] if done and dialogs else ("none", "no dialog")


def close(window):
    window.tk.call(window.protocol("WM_DELETE_WINDOW"))
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        try:
            # Tcl's update survives a destroyed Tk application; winfo does not.
            window.winfo_exists()
            window.update()
            time.sleep(.02)
        except tk.TclError:
            return True
    return False


def make_video(path, duration, size="160x90"):
    subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
                    f"testsrc2=size={size}:rate=24:duration={duration}", "-f", "lavfi", "-i",
                    f"sine=frequency=440:sample_rate=48000:duration={duration}", "-c:v", "libx264",
                    "-pix_fmt", "yuv420p", "-c:a", "aac", str(path)], check=True)


def verify(work: Path) -> None:
    settings = work / "gui-settings.json"
    source, rotated, long_video = work / "source.mp4", work / "rotated.mp4", work / "long.mp4"
    make_video(source, 2)
    make_video(long_video, 30, "1280x720")
    subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-display_rotation:v", "90", "-i", str(source),
                    "-c", "copy", str(rotated)], check=True)

    window = gui.VideoToolsApp(settings)
    window.update()
    check("window_opened", window.winfo_exists() and window.winfo_width() > 0, f"{window.winfo_width()}x{window.winfo_height()}")
    check("bundled_ffmpeg", Path(window.service.ffmpeg).resolve() == bundled_ffmpeg().resolve())
    check("video_probe", choose(window, source), window.info_var.get())

    single = next(mode for mode in window.output_mode_combo.cget("values") if mode != gui.GRID_OUTPUT_MODE)
    out = work / "out" / "png"
    window.output_var.set(str(out)); window.output_mode_var.set(single); window.format_var.set("PNG"); window.interval_var.set("0.5")
    window.size_mode_var.set(gui.SIZE_MODES[0]); window.size_preset_var.set(gui.CUSTOM_SIZE_LABEL)
    window.update()
    window.size_width_var.set("64"); window.size_height_var.set("36")
    window.update()
    kind, text = run(window)
    files = sorted(out.glob("*.png"))
    check("png_extraction", kind == "showinfo" and len(files) == 4, f"{kind}: {text.splitlines()[0]} files={len(files)}")
    check("png_size", files and all(probe_image(ffmpeg, path) == (64, 36) for path in files))
    kind, text = run(window)
    check("existing_png_skipped", kind == "showinfo" and len(sorted(out.glob("*.png"))) == 4, text.splitlines()[0])

    out = work / "out" / "grid"
    window.output_var.set(str(out)); window.output_mode_var.set(gui.GRID_OUTPUT_MODE); window.format_var.set("JPG")
    window.grid_size_var.set("2 × 2"); window.update()
    pump(window, lambda: False, .2)
    check("preview_drawn", window.preview_canvas.find_all(), window.preview_info_var.get())
    kind, text = run(window)
    files = sorted(out.glob("*.jpg"))
    check("jpg_grid", kind == "showinfo" and len(files) == 1 and files[0].read_bytes()[:3] == b"\xff\xd8\xff", text.splitlines()[0])

    window.interval_var.set("abc")
    dialogs.clear(); window.start_button.invoke(); window.update()
    check("invalid_interval_rejected", dialogs and dialogs[-1][0] == "showerror" and not window.current_job)
    window.interval_var.set("0.5")

    check("long_video_probe", choose(window, long_video), window.info_var.get())
    window.output_var.set(str(work / "out" / "cancel")); window.output_mode_var.set(single); window.interval_var.set("0.04")
    window.format_var.set("PNG"); window.size_width_var.set("1280"); window.size_height_var.set("720"); window.update()
    dialogs.clear(); window.start_button.invoke(); window.update()
    pump(window, lambda: False, .4)
    running = bool(window.current_job)
    window.cancel_button.invoke()
    pump(window, lambda: not window.current_job, 30)
    check("extraction_cancelled", running and window.status_var.get() == "취소됨" and not dialogs, window.status_var.get())
    check("cancel_published_nothing", not list((work / "out" / "cancel").glob("*.png")))

    window.notebook.select(1); window.update()
    check("edit_tab_selected", window.mode_var.get() == "edit", window.start_button.cget("text"))
    check("source_probe_for_edit", choose(window, source), window.info_var.get())
    fields = window.editor.fields
    output = work / "out" / "edited 한글.mp4"
    output.parent.mkdir(exist_ok=True)
    for key, value in {"output": str(output), "crop_enabled": True, "crop_x": "10", "crop_y": "10", "crop_width": "120", "crop_height": "60",
                       "rotation": "90", "flip_horizontal": True, "flip_vertical": True, "resize_enabled": True, "width": "128",
                       "height": "72", "speed": "2", "crf": "28", "mute": False}.items():
        fields[key].set(value)
    window.start_var.set("00:00:00"); window.update()
    kind, text = run(window)
    info = output.is_file() and probe_video(ffmpeg, output)
    check("edit_all_controls", kind == "showinfo" and info and info.display_size == (128, 72) and info.has_audio
          and abs(info.duration - 1) < .2, f"{kind}: {text.splitlines()[-1]}")
    kind, text = run(window)
    check("existing_output_refused", kind == "showerror", text.splitlines()[0])

    check("rotated_probe", choose(window, rotated), window.info_var.get())
    output = work / "out" / "rotated-edit.mp4"
    for key, value in {"output": str(output), "crop_enabled": False, "rotation": "0", "flip_horizontal": False, "flip_vertical": False,
                       "resize_enabled": False, "speed": "1", "crf": "20", "mute": True}.items():
        fields[key].set(value)
    window.update()
    kind, text = run(window)
    info = output.is_file() and probe_video(ffmpeg, output)
    check("rotated_mute_edit", kind == "showinfo" and info and info.display_size == (90, 160) and not info.has_audio,
          f"{kind}: {text.splitlines()[-1]}")

    expected_grid, expected_output = window.grid_size_var.get(), window.output_var.get()
    check("window_closed", close(window))
    check("settings_saved", settings.is_file())
    again = gui.VideoToolsApp(settings)
    again.update()
    check("settings_restored", again.grid_size_var.get() == expected_grid and again.output_var.get() == expected_output
          and again.editor.fields["mute"].get() is True, again.grid_size_var.get())
    close(again)
    check("no_callback_errors", not callback_errors, "\n".join(callback_errors)[-2000:])


def main() -> int:
    require_runtime()
    for name in ("showinfo", "showwarning", "showerror"):
        setattr(gui.messagebox, name, lambda title, text, kind=name, **_: dialogs.append((kind, text)))
    tk.Tk.report_callback_exception = lambda _self, kind, value, _trace: callback_errors.append(f"{kind.__name__}: {value}")
    with tempfile.TemporaryDirectory(prefix="video gui 한글 ", ignore_cleanup_errors=True) as temporary:
        verify(Path(temporary))
    failed = [name for name, ok in results if not ok]
    print(json.dumps({"total": len(results), "failed": failed}, ensure_ascii=False))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
