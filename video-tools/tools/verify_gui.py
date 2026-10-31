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

from video_tools.core.probe import probe_image, probe_video
from video_tools.gui import app as gui
from video_tools.gui import mcp_dialog, options
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
    check("start_button_readable", window.start_button.winfo_class() == "TButton" and window.start_button.cget("style") == "Accent.TButton")
    check("bundled_ffmpeg", Path(window.service.ffmpeg).resolve() == bundled_ffmpeg().resolve())
    check("video_probe", choose(window, source), window.info_var.get())

    single, grid = options.OUTPUT_MODE_LABELS["individual"], options.OUTPUT_MODE_LABELS["grid"]
    check("mode_labels_offered", set(window.extraction.output_mode_combo.cget("values")) == {single, grid}
          and set(window.extraction.size_mode_combo.cget("values")) == set(options.SIZE_MODE_LABELS.values()))
    out = work / "out" / "png"
    window.extraction.output_var.set(str(out)); window.extraction.output_mode_var.set(single); window.extraction.format_var.set("PNG"); window.interval_var.set("0.5")
    window.extraction.size_mode_var.set(options.SIZE_MODE_LABELS["final"]); window.extraction.size_preset_var.set(options.PRESET_LABELS["custom"])
    window.update()
    window.extraction.size_width_var.set("64"); window.extraction.size_height_var.set("36")
    window.update()
    dialogs.clear(); window.start_button.invoke(); window.update()
    check("settings_stay_visible_during_work", window.extraction.output_entry.winfo_ismapped() and window.current_job)
    check("other_tab_locked_during_work", window.notebook.tab(1, "state") == "disabled")
    pump(window, lambda: not window.current_job)
    kind, text = dialogs[-1] if dialogs else ("none", "no dialog")
    window.update()
    check("settings_visible_after_work", window.extraction.output_entry.winfo_ismapped())
    check("tabs_enabled_after_work", window.notebook.tab(1, "state") == "normal")
    files = sorted(out.glob("*.png"))
    check("png_extraction", kind == "showinfo" and len(files) == 4, f"{kind}: {text.splitlines()[0]} files={len(files)}")
    check("png_size", files and all(probe_image(ffmpeg, path) == (64, 36) for path in files))
    kind, text = run(window)
    check("existing_png_skipped", kind == "showinfo" and len(sorted(out.glob("*.png"))) == 4, text.splitlines()[0])

    out = work / "out" / "grid"
    window.extraction.output_var.set(str(out)); window.extraction.output_mode_var.set(grid); window.extraction.format_var.set("JPG")
    window.extraction.grid_size_var.set("2 × 2"); window.update()
    pump(window, lambda: False, .2)
    check("preview_drawn", window.extraction.preview_canvas.find_all(), window.extraction.preview_info_var.get())
    kind, text = run(window)
    files = sorted(out.glob("*.jpg"))
    check("jpg_grid", kind == "showinfo" and len(files) == 1 and files[0].read_bytes()[:3] == b"\xff\xd8\xff", text.splitlines()[0])

    window.interval_var.set("abc")
    dialogs.clear(); window.start_button.invoke(); window.update()
    check("invalid_interval_rejected", dialogs and dialogs[-1][0] == "showerror" and not window.current_job)
    window.interval_var.set("0.5")

    check("long_video_probe", choose(window, long_video), window.info_var.get())
    window.extraction.output_var.set(str(work / "out" / "cancel")); window.extraction.output_mode_var.set(single); window.interval_var.set("0.04")
    window.extraction.format_var.set("PNG"); window.extraction.size_width_var.set("1280"); window.extraction.size_height_var.set("720"); window.update()
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

    expected_grid, expected_output = window.extraction.grid_size_var.get(), window.extraction.output_var.get()
    check("window_closed", close(window))
    saved = json.loads(settings.read_text(encoding="utf-8")) if settings.is_file() else {}
    check("settings_store_modes_not_labels", saved.get("output_mode") == "individual" and saved.get("size_mode") == "final",
          (saved.get("output_mode"), saved.get("size_mode")))
    again = gui.VideoToolsApp(settings)
    again.update()
    check("settings_restored", again.extraction.grid_size_var.get() == expected_grid and again.extraction.output_var.get() == expected_output
          and again.editor.fields["mute"].get() is True, again.extraction.grid_size_var.get())
    close(again)

    # A settings file from before the modes were separated from their labels.
    old = work / "old-settings.json"
    old.write_text(json.dumps({"output_mode": "개별 이미지 저장", "size_mode": "격자 셀 이미지 크기", "size_preset": "사용자 지정",
                               "prefix": "유지"}, ensure_ascii=False), encoding="utf-8")
    upgraded = gui.VideoToolsApp(old)
    upgraded.update()
    check("old_settings_use_defaults", upgraded.extraction.output_mode_var.get() == grid and upgraded.extraction.size_mode_var.get() == options.SIZE_MODE_LABELS["final"]
          and upgraded.extraction.prefix_var.get() == "유지", upgraded.summary_var.get())
    close(upgraded)


def select(window, combo, variable, value):
    # Setting the variable alone does not run the handlers a real selection does.
    variable.set(value)
    combo.event_generate("<<ComboboxSelected>>")
    pump(window, lambda: False, .15)


def verify_output_controls(work: Path) -> None:
    window = gui.VideoToolsApp(work / "control-settings.json")
    pump(window, lambda: False, .4)
    cell, final = options.SIZE_MODE_LABELS["cell"], options.SIZE_MODE_LABELS["final"]
    single, grid = options.OUTPUT_MODE_LABELS["individual"], options.OUTPUT_MODE_LABELS["grid"]

    select(window, window.extraction.size_mode_combo, window.extraction.size_mode_var, cell)
    values = set(window.extraction.size_preset_combo.cget("values"))
    check("cell_mode_presets", values == {options.preset_label(preset) for preset in (*options.CELL_SIZE_PRESETS, "custom")}, sorted(values))
    select(window, window.extraction.size_preset_combo, window.extraction.size_preset_var, options.PRESET_LABELS["original"])
    check("original_size_clears_entries", window.extraction.size_width_var.get() == "" and str(window.extraction.size_width_entry.cget("state")) == "disabled")
    check("original_size_summary", "원본 셀 크기" in window.summary_var.get(), window.summary_var.get())
    select(window, window.extraction.size_preset_combo, window.extraction.size_preset_var, options.PRESET_LABELS["custom"])
    check("custom_size_enables_entries", str(window.extraction.size_width_entry.cget("state")) == "normal")
    window.extraction.size_width_var.set("321"); window.extraction.size_height_var.set("123"); window.update()
    check("custom_cell_summary", "셀 321 × 123" in window.summary_var.get(), window.summary_var.get())
    select(window, window.extraction.size_mode_combo, window.extraction.size_mode_var, final)
    check("final_mode_presets", set(window.extraction.size_preset_combo.cget("values")) == {*options.FINAL_SIZE_PRESETS, options.PRESET_LABELS["custom"]})
    select(window, window.extraction.size_preset_combo, window.extraction.size_preset_var, "4096 × 4096")
    check("preset_fills_entries", (window.extraction.size_width_var.get(), window.extraction.size_height_var.get()) == ("4096", "4096"))
    select(window, window.extraction.output_mode_combo, window.extraction.output_mode_var, single)
    check("individual_disables_grid", str(window.extraction.grid_size_combo.cget("state")) == "disabled")
    check("individual_summary", "개별 이미지" in window.summary_var.get(), window.summary_var.get())
    select(window, window.extraction.output_mode_combo, window.extraction.output_mode_var, grid)
    check("grid_enables_grid", str(window.extraction.grid_size_combo.cget("state")) == "readonly")

    window.scroll_canvas.yview_moveto(0); window.update()
    window.scroll_canvas.yview_moveto(1)
    pump(window, lambda: False, .1)
    check("content_scrolls", window.scroll_canvas.yview()[0] > 0, window.scroll_canvas.yview())
    verify_mcp_dialog(window, work)
    select(window, window.extraction.size_mode_combo, window.extraction.size_mode_var, cell)
    select(window, window.extraction.size_preset_combo, window.extraction.size_preset_var, options.PRESET_LABELS["original"])
    settings_path = work / "control-settings.json"
    check("controls_window_closed", close(window))
    saved = json.loads(settings_path.read_text(encoding="utf-8")) if settings_path.is_file() else {}
    check("settings_store_preset_value", saved.get("size_preset") == "original", saved.get("size_preset"))


def verify_mcp_dialog(window, work: Path) -> None:
    def walk(widget):
        yield widget
        for child in widget.winfo_children():
            yield from walk(child)

    mcp_dialog.show_mcp_configuration(window)
    pump(window, lambda: False, .2)
    dialog = next(child for child in window.winfo_children() if isinstance(child, tk.Toplevel))
    widgets = list(walk(dialog))
    buttons = {widget.cget("text"): widget for widget in widgets if widget.winfo_class() == "TButton"}
    entry = next(widget for widget in widgets if widget.winfo_class() == "TEntry")
    text = next(widget for widget in widgets if widget.winfo_class() == "Text")
    dialogs.clear()
    buttons["설정 생성"].invoke(); window.update()
    check("mcp_dialog_requires_folder", dialogs and dialogs[-1][0] == "showerror")
    workspace = work / "mcp 작업 폴더"
    entry.insert(0, str(workspace))
    buttons["설정 생성"].invoke(); window.update()
    value = json.loads(text.get("1.0", "end"))
    check("mcp_dialog_generates", value["mcpServers"]["video-tools"]["args"][-1] == str(workspace.resolve()))
    buttons["복사"].invoke(); window.update()
    check("mcp_dialog_copies", json.loads(window.clipboard_get()) == value)
    saved = work / "mcp-config.json"
    mcp_dialog.filedialog.asksaveasfilename = lambda **_: str(saved)
    buttons["파일 저장"].invoke(); window.update()
    check("mcp_dialog_saves", saved.is_file() and json.loads(saved.read_text(encoding="utf-8")) == value)
    dialog.destroy()


def main() -> int:
    require_runtime()
    for name in ("showinfo", "showwarning", "showerror"):
        setattr(gui.messagebox, name, lambda title, text, kind=name, **_: dialogs.append((kind, text)))
    tk.Tk.report_callback_exception = lambda _self, kind, value, _trace: callback_errors.append(f"{kind.__name__}: {value}")
    with tempfile.TemporaryDirectory(prefix="video gui 한글 ", ignore_cleanup_errors=True) as temporary:
        verify(Path(temporary))
        verify_output_controls(Path(temporary))
    check("no_callback_errors", not callback_errors, "\n".join(callback_errors)[-2000:])
    failed = [name for name, ok in results if not ok]
    print(json.dumps({"total": len(results), "failed": failed}, ensure_ascii=False))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
