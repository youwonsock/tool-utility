"""VideoToImage 설정 파일 모델과 호환 가능한 저장소."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field, asdict
import sys
from pathlib import Path
from typing import Any

from video_to_image_domain import (
    CELL_SIZE_PRESETS,
    CUSTOM_SIZE_LABEL,
    FINAL_SIZE_PRESETS,
    GRID_OUTPUT_MODE,
    GRID_SIZE_PRESETS,
    INDIVIDUAL_OUTPUT_MODE,
    OUTPUT_MODES,
    parse_positive_float,
    SIZE_MODES,
)


from video_to_image_runtime import default_settings_path

SETTINGS_PATH = default_settings_path()


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
    if normalized['rotation'] not in ('0', '90', '180', '270'):
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
    grid_size: str = "3 × 3"
    size_mode: str = SIZE_MODES[0]
    size_preset: str = "1920 × 1080"
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


def _migrate_output_mode(raw_value: Any) -> str:
    if raw_value in OUTPUT_MODES:
        return str(raw_value)
    if raw_value == "1초 이미지 개별 저장":
        return INDIVIDUAL_OUTPUT_MODE
    if raw_value == "9초씩 3 × 3 합치기":
        return GRID_OUTPUT_MODE
    return GRID_OUTPUT_MODE


def _migrate_size_settings(raw: dict[str, Any]) -> tuple[str, str]:
    if "size_mode" in raw or "size_preset" in raw:
        size_mode = _text_value(raw, "size_mode", SIZE_MODES[0])
        if size_mode not in SIZE_MODES:
            size_mode = SIZE_MODES[0]
        size_preset = _text_value(raw, "size_preset", "1920 × 1080")
        available = FINAL_SIZE_PRESETS if size_mode == SIZE_MODES[0] else CELL_SIZE_PRESETS
        if size_preset not in available and size_preset != CUSTOM_SIZE_LABEL:
            size_preset = "1920 × 1080" if size_mode == SIZE_MODES[0] else "원본"
        return size_mode, size_preset

    legacy_resolution = raw.get("resolution")
    legacy_sheet_size = raw.get("sheet_size")
    if isinstance(legacy_sheet_size, str):
        legacy_final_size = legacy_sheet_size.replace(" 이하", "")
        if legacy_final_size in FINAL_SIZE_PRESETS:
            return SIZE_MODES[0], legacy_final_size
        if legacy_sheet_size == "제한 없음":
            if isinstance(legacy_resolution, str) and legacy_resolution in CELL_SIZE_PRESETS:
                return SIZE_MODES[1], legacy_resolution
            return SIZE_MODES[1], "원본"
    return SIZE_MODES[0], "1920 × 1080"


def _migrate_interval(raw: dict[str, Any]) -> str:
    interval = _text_value(raw, "interval", AppSettings.interval)
    try:
        parse_positive_float(interval, "추출 간격")
    except ValueError:
        return AppSettings.interval
    return interval


def _migrate_format(raw: dict[str, Any]) -> str:
    image_format = _text_value(raw, "format", AppSettings.format).upper()
    return image_format if image_format in {"PNG", "JPG"} else AppSettings.format


def settings_from_dict(raw: dict[str, Any]) -> AppSettings:
    """현재 형식 또는 기존 형식의 JSON 객체를 설정 모델로 변환한다."""

    size_mode, size_preset = _migrate_size_settings(raw)
    grid_size = _text_value(raw, "grid_size", "3 × 3")
    if grid_size not in GRID_SIZE_PRESETS:
        grid_size = "3 × 3"
    overwrite = raw.get("overwrite")
    geometry = raw.get("geometry")
    return AppSettings(
        output=_text_value(raw, "output", AppSettings.output),
        prefix=_text_value(raw, "prefix", AppSettings.prefix),
        format=_migrate_format(raw),
        interval=_migrate_interval(raw),
        output_mode=_migrate_output_mode(raw.get("output_mode")),
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

    implicit = path is None
    path = path if path is not None else default_settings_path()
    if implicit and sys.platform == "darwin" and not path.exists():
        legacy = Path.home() / "AppData/Roaming/VideoToImage/settings.json"
        if legacy.is_file():
            try:
                raw = json.loads(legacy.read_text(encoding="utf-8"))
                if isinstance(raw, dict):
                    settings = settings_from_dict(raw)
                    save_settings(settings, path)
                    return settings
            except (OSError, UnicodeError, json.JSONDecodeError):
                pass
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, UnicodeError, json.JSONDecodeError):
        return AppSettings()
    if not isinstance(raw, dict):
        return AppSettings()
    return settings_from_dict(raw)


def save_settings(settings: AppSettings, path: Path | None = None) -> bool:
    """설정을 기존 JSON 키와 호환되는 형식으로 저장한다."""

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
