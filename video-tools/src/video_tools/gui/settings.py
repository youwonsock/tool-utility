"""Current settings model and atomic per-user storage."""

from __future__ import annotations

import json
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any

from video_tools.core.domain import SIZE_MODES
from video_tools.core.limits import ROTATIONS
from video_tools.gui.options import CELL_SIZE_PRESETS, CUSTOM_SIZE_LABEL, DEFAULT_CELL_SIZE, DEFAULT_FINAL_SIZE, DEFAULT_GRID_SIZE, FINAL_SIZE_PRESETS, GRID_OUTPUT_MODE, GRID_SIZE_PRESETS, OUTPUT_MODES, parse_positive_float
from video_tools.runtime import default_settings_path


@dataclass(frozen=True)
class EditingSettings:
    output: str = ""
    crop_enabled: bool = False
    crop_x: str = "0"
    crop_y: str = "0"
    crop_width: str = "640"
    crop_height: str = "360"
    resize_enabled: bool = False
    width: str = "1280"
    height: str = "720"
    rotation: str = "0"
    flip_horizontal: bool = False
    flip_vertical: bool = False
    speed: str = "1"
    mute: bool = False
    overwrite: bool = False
    crf: str = "20"

def editing_from_dict(raw):
    defaults = asdict(EditingSettings())
    if not isinstance(raw, dict):
        return EditingSettings()
    normalized = {}
    for key, default in defaults.items():
        value = raw.get(key, default)
        normalized[key] = value if isinstance(value, type(default)) else default
    if normalized['rotation'] not in tuple(map(str, ROTATIONS)):
        normalized['rotation'] = '0'
    return EditingSettings(**normalized)


@dataclass(frozen=True)
class AppSettings:
    """UI가 시작할 때 사용할 저장 가능한 설정 값."""

    output: str = str(Path.home() / "Desktop" / "추출이미지")
    prefix: str = "frame"
    format: str = "PNG"
    interval: str = "1"
    output_mode: str = GRID_OUTPUT_MODE
    grid_size: str = DEFAULT_GRID_SIZE
    size_mode: str = SIZE_MODES[0]
    size_preset: str = DEFAULT_FINAL_SIZE
    size_width: str = "1920"
    size_height: str = "1080"
    overwrite: bool = False
    geometry: str = ""
    editing: EditingSettings = field(default_factory=EditingSettings)


def _text_value(raw: dict[str, Any], key: str, default: str) -> str:
    value = raw.get(key)
    if isinstance(value, bool):
        return default
    return str(value) if isinstance(value, (str, int, float)) and str(value).strip() else default


def _size_settings(raw: dict[str, Any]) -> tuple[str, str]:
    size_mode = _text_value(raw, "size_mode", SIZE_MODES[0])
    if size_mode not in SIZE_MODES:
        size_mode = SIZE_MODES[0]
    available = FINAL_SIZE_PRESETS if size_mode == SIZE_MODES[0] else CELL_SIZE_PRESETS
    default = DEFAULT_FINAL_SIZE if size_mode == SIZE_MODES[0] else DEFAULT_CELL_SIZE
    preset = _text_value(raw, "size_preset", default)
    if preset not in available and preset != CUSTOM_SIZE_LABEL:
        preset = default
    return size_mode, preset


def _interval(raw: dict[str, Any]) -> str:
    interval = _text_value(raw, "interval", AppSettings.interval)
    try:
        parse_positive_float(interval, "추출 간격")
    except ValueError:
        return AppSettings.interval
    return interval


def _format(raw: dict[str, Any]) -> str:
    value = _text_value(raw, "format", AppSettings.format).upper()
    return value if value in {"PNG", "JPG"} else AppSettings.format


def settings_from_dict(raw: dict[str, Any]) -> AppSettings:
    """Read current fields; invalid or missing values use defaults."""

    size_mode, size_preset = _size_settings(raw)
    grid_size = _text_value(raw, "grid_size", DEFAULT_GRID_SIZE)
    if grid_size not in GRID_SIZE_PRESETS:
        grid_size = DEFAULT_GRID_SIZE
    overwrite = raw.get("overwrite")
    geometry = raw.get("geometry")
    return AppSettings(
        output=_text_value(raw, "output", AppSettings.output),
        prefix=_text_value(raw, "prefix", AppSettings.prefix),
        format=_format(raw),
        interval=_interval(raw),
        output_mode=raw.get("output_mode") if raw.get("output_mode") in OUTPUT_MODES else AppSettings.output_mode,
        grid_size=grid_size,
        size_mode=size_mode,
        size_preset=size_preset,
        size_width=_text_value(raw, "size_width", AppSettings.size_width),
        size_height=_text_value(raw, "size_height", AppSettings.size_height),
        overwrite=overwrite if isinstance(overwrite, bool) else AppSettings.overwrite,
        geometry=geometry if isinstance(geometry, str) else AppSettings.geometry,
        editing=editing_from_dict(raw.get("editing")),
    )


def load_settings(path: Path | None = None) -> AppSettings:
    """설정 파일을 읽고 실패하면 기본 설정을 반환한다."""

    path = path if path is not None else default_settings_path()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, UnicodeError, json.JSONDecodeError):
        return AppSettings()
    if not isinstance(raw, dict):
        return AppSettings()
    return settings_from_dict(raw)


def save_settings(settings: AppSettings, path: Path | None = None) -> bool:
    """Atomically save the current settings fields."""

    path = path if path is not None else default_settings_path()
    raw = {
        "output": settings.output,
        "prefix": settings.prefix,
        "format": settings.format,
        "interval": settings.interval,
        "output_mode": settings.output_mode,
        "grid_size": settings.grid_size,
        "size_mode": settings.size_mode,
        "size_preset": settings.size_preset,
        "size_width": settings.size_width,
        "size_height": settings.size_height,
        "overwrite": settings.overwrite,
        "geometry": settings.geometry,
        "editing": asdict(settings.editing),
    }
    temporary_path: Path | None = None
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary_path = path.with_name(f".{path.name}.tmp")
        temporary_path.write_text(json.dumps(raw, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary_path.replace(path)
    except OSError:
        return False
    finally:
        if temporary_path is not None:
            try:
                temporary_path.unlink(missing_ok=True)
            except OSError:
                pass
    return True
