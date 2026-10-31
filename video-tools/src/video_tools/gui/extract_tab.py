"""Tk controls for the image extraction tab."""

from __future__ import annotations

from pathlib import Path
from typing import Optional
import tkinter as tk
from tkinter import filedialog, ttk

from video_tools.core.domain import SIZE_MODE_FINAL, calculate_expected_output_count, resolve_size_plan, safe_prefix
from video_tools.core.extraction import ExtractionRequest
from video_tools.gui import theme
from video_tools.gui.options import CELL_SIZE_PRESETS, DEFAULT_CELL_SIZE, DEFAULT_FINAL_SIZE, FINAL_SIZE_PRESETS, GRID_SIZE_PRESETS, OUTPUT_MODE_GRID, OUTPUT_MODE_LABELS, PREVIEW_CANVAS_HEIGHT, PRESET_CUSTOM, PRESET_LABELS, SIZE_MODE_LABELS, format_time, mode_for_label, parse_grid_layout, parse_positive_float, parse_positive_int, parse_time, preset_label, resolve_preview_plan
from video_tools.gui.preview import PreviewCanvasRenderer
from video_tools.gui.settings import AppSettings


class ExtractionControls:
    def __init__(self, app, parent: ttk.Frame, settings: AppSettings) -> None:
        self.app = app
        self.output_var = tk.StringVar(app, value=settings.output)
        self.prefix_var = tk.StringVar(app, value=settings.prefix)
        self.format_var = tk.StringVar(app, value=settings.format)
        self.output_mode_var = tk.StringVar(app, value=OUTPUT_MODE_LABELS[settings.output_mode])
        self.grid_size_var = tk.StringVar(app, value=settings.grid_size)
        self.size_mode_var = tk.StringVar(app, value=SIZE_MODE_LABELS[settings.size_mode])
        self.size_preset_var = tk.StringVar(app, value=preset_label(settings.size_preset))
        self.size_width_var = tk.StringVar(app, value=settings.size_width)
        self.size_height_var = tk.StringVar(app, value=settings.size_height)
        self.overwrite_var = tk.BooleanVar(app, value=settings.overwrite)
        self.preview_info_var = tk.StringVar(app, value="현재 설정의 합성 샘플을 표시합니다.")
        self.preview_after_id: Optional[str] = None
        self._build_output_card(parent)
        self._build_preview_card(parent)

    def _build_output_card(self, parent: ttk.Frame) -> None:
        card = theme.card(parent)
        ttk.Label(card, text="3. 저장 설정", style="CardTitle.TLabel").grid(row=0, column=0, columnspan=4, sticky="w")
        ttk.Label(card, text="같은 이름의 파일이 있을 때만 덮어쓰기를 선택할 수 있습니다.", style="CardText.TLabel").grid(
            row=1, column=0, columnspan=4, sticky="w", pady=(4, 9)
        )
        ttk.Label(card, text="저장 폴더", style="CardText.TLabel").grid(row=2, column=0, sticky="w")
        self.output_entry = ttk.Entry(card, textvariable=self.output_var, style="Card.TEntry")
        self.output_entry.grid(row=3, column=0, columnspan=3, sticky="ew", pady=(4, 0))
        self.output_button = ttk.Button(card, text="폴더 선택", style="Secondary.TButton", command=self._choose_output)
        self.output_button.grid(row=3, column=3, padx=(10, 0), pady=(4, 0))
        ttk.Label(card, text="파일명 앞부분", style="CardText.TLabel").grid(row=4, column=0, columnspan=2, sticky="w", pady=(10, 0))
        self.prefix_entry = ttk.Entry(card, textvariable=self.prefix_var, style="Card.TEntry")
        self.prefix_entry.grid(row=5, column=0, columnspan=2, sticky="ew", pady=(4, 0))
        ttk.Label(card, text="형식", style="CardText.TLabel").grid(row=4, column=2, sticky="w", padx=(12, 0), pady=(10, 0))
        self.format_combo = ttk.Combobox(
            card,
            textvariable=self.format_var,
            values=("PNG", "JPG"),
            state="readonly",
            width=10,
            style="Card.TCombobox",
        )
        self.format_combo.grid(row=5, column=2, sticky="w", padx=(12, 0), pady=(4, 0))
        self.overwrite_check = ttk.Checkbutton(
            card,
            text="기존 파일 덮어쓰기",
            variable=self.overwrite_var,
            style="Card.TCheckbutton",
        )
        self.overwrite_check.grid(row=5, column=3, sticky="w", padx=(12, 0), pady=(4, 0))

        ttk.Label(card, text="출력 방식", style="CardText.TLabel").grid(row=6, column=0, columnspan=2, sticky="w", pady=(10, 0))
        ttk.Label(card, text="격자 크기", style="CardText.TLabel").grid(row=6, column=2, columnspan=2, sticky="w", padx=(12, 0), pady=(10, 0))
        self.output_mode_combo = ttk.Combobox(
            card,
            textvariable=self.output_mode_var,
            values=tuple(OUTPUT_MODE_LABELS.values()),
            state="readonly",
            style="Card.TCombobox",
        )
        self.output_mode_combo.grid(row=7, column=0, columnspan=2, sticky="ew", pady=(4, 0))

        self.grid_size_combo = ttk.Combobox(
            card,
            textvariable=self.grid_size_var,
            values=tuple(GRID_SIZE_PRESETS.keys()),
            state="readonly",
            style="Card.TCombobox",
        )
        self.grid_size_combo.grid(row=7, column=2, columnspan=2, sticky="ew", padx=(12, 0), pady=(4, 0))

        ttk.Label(card, text="이미지 크기 모드", style="CardText.TLabel").grid(row=8, column=0, columnspan=2, sticky="w", pady=(10, 0))
        ttk.Label(card, text="크기 프리셋", style="CardText.TLabel").grid(row=8, column=2, columnspan=2, sticky="w", padx=(12, 0), pady=(10, 0))
        self.size_mode_combo = ttk.Combobox(
            card,
            textvariable=self.size_mode_var,
            values=tuple(SIZE_MODE_LABELS.values()),
            state="readonly",
            style="Card.TCombobox",
        )
        self.size_mode_combo.grid(row=9, column=0, columnspan=2, sticky="ew", pady=(4, 0))
        self.size_preset_combo = ttk.Combobox(
            card,
            textvariable=self.size_preset_var,
            state="readonly",
            style="Card.TCombobox",
        )
        self.size_preset_combo.grid(row=9, column=2, columnspan=2, sticky="ew", padx=(12, 0), pady=(4, 0))

        ttk.Label(card, text="너비(px)", style="CardText.TLabel").grid(row=10, column=0, sticky="w", pady=(10, 0))
        ttk.Label(card, text="높이(px)", style="CardText.TLabel").grid(row=10, column=1, sticky="w", padx=(12, 0), pady=(10, 0))
        self.size_width_entry = ttk.Entry(card, textvariable=self.size_width_var, width=12, style="Card.TEntry")
        self.size_width_entry.grid(row=11, column=0, sticky="ew", pady=(4, 0))
        self.size_height_entry = ttk.Entry(card, textvariable=self.size_height_var, width=12, style="Card.TEntry")
        self.size_height_entry.grid(row=11, column=1, sticky="ew", padx=(12, 0), pady=(4, 0))
        ttk.Label(card, text="사용자 지정 선택 시 직접 입력", style="CardText.TLabel").grid(
            row=11, column=2, columnspan=2, sticky="w", padx=(12, 0), pady=(4, 0)
        )

        self.output_mode_combo.bind("<<ComboboxSelected>>", self._on_output_mode_changed)
        self.size_mode_combo.bind("<<ComboboxSelected>>", self._on_size_mode_changed)
        self.size_preset_combo.bind("<<ComboboxSelected>>", self._on_size_preset_changed)
        for variable in (
            self.app.start_var,
            self.app.end_var,
            self.app.interval_var,
            self.output_mode_var,
            self.grid_size_var,
            self.size_mode_var,
            self.size_preset_var,
            self.size_width_var,
            self.size_height_var,
        ):
            variable.trace_add("write", self._on_summary_variable_changed)
        card.columnconfigure(0, weight=1)
        card.columnconfigure(1, weight=1)
        card.columnconfigure(2, weight=1)
        card.columnconfigure(3, weight=1)
        self._sync_output_controls()
        self._sync_size_controls()

    def _build_preview_card(self, parent: ttk.Frame) -> None:
        card = theme.card(parent)
        ttk.Label(card, text="4. 결과물 미리보기", style="CardTitle.TLabel").grid(
            row=0, column=0, columnspan=4, sticky="w"
        )
        ttk.Label(
            card,
            text="실제 동영상이나 FFmpeg를 사용하지 않는 합성 샘플입니다. 설정 변경 시 자동으로 갱신됩니다.",
            style="CardText.TLabel",
        ).grid(row=1, column=0, columnspan=4, sticky="w", pady=(4, 6))
        ttk.Label(
            card,
            textvariable=self.preview_info_var,
            style="CardText.TLabel",
            wraplength=680,
        ).grid(row=2, column=0, columnspan=4, sticky="w")
        self.preview_canvas = tk.Canvas(
            card,
            height=PREVIEW_CANVAS_HEIGHT,
            background="#e2e8f0",
            highlightthickness=0,
            bd=0,
        )
        self.preview_renderer = PreviewCanvasRenderer(self.preview_canvas, self.app.font_family)
        self.preview_canvas.grid(row=3, column=0, columnspan=4, sticky="ew", pady=(10, 0))
        self.preview_canvas.bind("<Configure>", lambda _event: self._schedule_preview_update())
        for index in range(4):
            card.columnconfigure(index, weight=1)

    def _on_output_mode_changed(self, _event: object = None) -> None:
        self._sync_output_controls()

    def _on_size_mode_changed(self, _event: object = None) -> None:
        if self._size_preset() not in self._available_size_presets():
            self.size_preset_var.set(preset_label(self._default_size_preset()))
        self._sync_size_controls()

    def _on_size_preset_changed(self, _event: object = None) -> None:
        self._sync_size_controls()

    def _on_summary_variable_changed(self, *_args: object) -> None:
        self.app.update_output_summary()
        self._schedule_preview_update()

    def _output_mode(self) -> str:
        return mode_for_label(OUTPUT_MODE_LABELS, self.output_mode_var.get(), OUTPUT_MODE_GRID)

    def _size_mode(self) -> str:
        return mode_for_label(SIZE_MODE_LABELS, self.size_mode_var.get(), SIZE_MODE_FINAL)

    def _size_preset(self) -> str:
        return mode_for_label(PRESET_LABELS, self.size_preset_var.get(), self.size_preset_var.get())

    def _available_size_presets(self) -> dict[str, Optional[tuple[int, int]]]:
        if self._size_mode() == SIZE_MODE_FINAL:
            return {**FINAL_SIZE_PRESETS, PRESET_CUSTOM: None}
        return {**CELL_SIZE_PRESETS, PRESET_CUSTOM: None}

    def _default_size_preset(self) -> str:
        return DEFAULT_FINAL_SIZE if self._size_mode() == SIZE_MODE_FINAL else DEFAULT_CELL_SIZE

    def _sync_output_controls(self) -> None:
        if not hasattr(self, "grid_size_combo"):
            return
        state = "readonly" if self._output_mode() == OUTPUT_MODE_GRID else "disabled"
        self.grid_size_combo.configure(state=state)
        self.app.update_output_summary()

    def _sync_size_controls(self) -> None:
        if not hasattr(self, "size_preset_combo"):
            return
        if self.size_mode_var.get() not in SIZE_MODE_LABELS.values():
            self.size_mode_var.set(SIZE_MODE_LABELS[SIZE_MODE_FINAL])
        available = self._available_size_presets()
        self.size_preset_combo.configure(values=tuple(map(preset_label, available)), state="readonly")
        preset = self._size_preset()
        if preset not in available:
            preset = self._default_size_preset()
            self.size_preset_var.set(preset_label(preset))

        selected_size = available[preset]
        if preset == PRESET_CUSTOM:
            self.size_width_entry.configure(state="normal")
            self.size_height_entry.configure(state="normal")
            self.app.update_output_summary()
            return

        self.size_width_entry.configure(state="disabled")
        self.size_height_entry.configure(state="disabled")
        if selected_size is None:
            self.size_width_var.set("")
            self.size_height_var.set("")
        else:
            width, height = selected_size
            self.size_width_var.set(str(width))
            self.size_height_var.set(str(height))
        self.app.update_output_summary()

    def _read_requested_size(self) -> Optional[tuple[int, int]]:
        preset = self._size_preset()
        available = self._available_size_presets()
        if preset not in available:
            raise ValueError("크기 프리셋을 선택해 주세요.")
        if preset == PRESET_CUSTOM:
            return (
                parse_positive_int(self.size_width_var.get(), "너비"),
                parse_positive_int(self.size_height_var.get(), "높이"),
            )
        return available[preset]

    def _schedule_preview_update(self, *_args: object) -> None:
        """설정 변경을 한 번 모아 미리보기를 갱신한다."""

        if not hasattr(self, "preview_canvas"):
            return
        if self.preview_after_id is not None:
            try:
                self.app.after_cancel(self.preview_after_id)
            except (tk.TclError, ValueError):
                pass
        self.preview_after_id = self.app.after_idle(self._render_preview)

    def _render_preview(self) -> None:
        """현재 설정을 반영한 합성 샘플 한 장을 그린다."""

        self.preview_after_id = None
        if not hasattr(self, "preview_canvas"):
            return

        group_mode = self._output_mode() == OUTPUT_MODE_GRID
        grid_size = GRID_SIZE_PRESETS.get(self.grid_size_var.get(), (3, 3))
        try:
            requested_size = self._read_requested_size()
            preview_plan = resolve_preview_plan(
                self._size_mode(),
                requested_size,
                group_mode,
                grid_size,
            )
            start = parse_time(self.app.start_var.get())
            interval = parse_positive_float(self.app.interval_var.get(), "추출 간격")
            end_text = self.app.end_var.get().strip()
            end = parse_time(end_text) if end_text else None
            if end is not None and end <= start:
                raise ValueError("끝 시간은 시작 시간보다 커야 합니다.")
        except ValueError as exc:
            self.preview_info_var.set(f"미리보기를 표시할 수 없습니다 · {exc}")
            self.preview_renderer.draw_message(str(exc))
            return

        cell_width, cell_height = preview_plan.cell_size
        output_width, output_height = preview_plan.output_size
        if preview_plan.uses_sample_size:
            size_text = f"원본 비율 예시 · 셀 {cell_width} × {cell_height}"
        else:
            size_text = f"셀 {cell_width} × {cell_height} · 최종 {output_width} × {output_height}"
        mode_text = self.grid_size_var.get() if group_mode else "개별 이미지"
        end_label = f" · 끝 {format_time(end)}" if end is not None else ""
        self.preview_info_var.set(
            f"합성 샘플 · {mode_text} · {size_text} · 시작 {format_time(start)} · "
            f"간격 {interval:g}초{end_label}"
        )

        sample_count = preview_plan.grid_size[0] * preview_plan.grid_size[1]
        sample_times = [start + index * interval for index in range(sample_count)]
        if end is not None:
            sample_times = [sample_time for sample_time in sample_times if sample_time < end]
        self.preview_renderer.draw(preview_plan, sample_times)

    def _choose_output(self) -> None:
        selected = filedialog.askdirectory(title="이미지 저장 폴더 선택")
        if selected:
            self.output_var.set(selected)

    def summary(self) -> tuple[str, bool]:
        """Return the expected output text and whether it reports an error."""
        group_mode = self._output_mode() == OUTPUT_MODE_GRID
        grid_size = GRID_SIZE_PRESETS.get(self.grid_size_var.get(), (3, 3))
        effective_grid_size = grid_size if group_mode else (1, 1)
        try:
            size_plan = resolve_size_plan(self._size_mode(), self._read_requested_size(), group_mode, effective_grid_size)
        except ValueError as exc:
            return f"설정을 확인하세요 · {exc}", True

        if not group_mode:
            if size_plan.output_size is None:
                return "예상 출력 · 개별 이미지 · 원본 크기", False
            width, height = size_plan.output_size
            return f"예상 출력 · 개별 이미지 · {width} × {height}", False

        grid_label = self.grid_size_var.get()
        if size_plan.output_size is None:
            return f"예상 출력 · {grid_label} · 원본 셀 크기 · 최종 크기는 영상 기준", False

        output_width, output_height = size_plan.output_size
        if size_plan.frame_size is None:
            cell_text = "원본 셀 크기"
        else:
            cell_width, cell_height = size_plan.frame_size
            cell_text = f"셀 {cell_width} × {cell_height}"
        return f"예상 출력 · {grid_label} · {cell_text} · 최종 {output_width} × {output_height}", False

    def request(self, video_path: Path, start: float, end: float, interval: float) -> tuple[ExtractionRequest, int]:
        """Build the request and the expected image count; raises ValueError or OSError on bad input."""
        group_mode = self._output_mode() == OUTPUT_MODE_GRID
        grid_size = parse_grid_layout(self.grid_size_var.get())
        effective_grid_size = grid_size if group_mode else (1, 1)
        size_plan = resolve_size_plan(self._size_mode(), self._read_requested_size(), group_mode, effective_grid_size)
        output_text = self.output_var.get().strip()
        if not output_text:
            raise ValueError("저장 폴더를 입력해 주세요.")
        output_dir = Path(output_text).expanduser().resolve()
        output_dir.mkdir(parents=True, exist_ok=True)
        request = ExtractionRequest(
            video_path=video_path,
            output_dir=output_dir,
            prefix=safe_prefix(self.prefix_var.get(), video_path.stem + "_frame"),
            extension="png" if self.format_var.get().upper() == "PNG" else "jpg",
            start=start,
            end=end,
            interval=interval,
            overwrite=self.overwrite_var.get(),
            group_mode=group_mode,
            grid_size=effective_grid_size,
            size_plan=size_plan,
        )
        return request, calculate_expected_output_count(start, end, interval, group_mode, effective_grid_size)

    def set_enabled(self, state: str) -> None:
        for widget in (self.output_entry, self.output_button, self.prefix_entry, self.format_combo, self.output_mode_combo,
                       self.grid_size_combo, self.size_mode_combo, self.size_preset_combo, self.size_width_entry,
                       self.size_height_entry, self.overwrite_check):
            widget.configure(state=state)
        if state == "normal":
            for combo in (self.format_combo, self.output_mode_combo, self.size_mode_combo):
                combo.configure(state="readonly")
            self._sync_output_controls()
            self._sync_size_controls()

    def settings_values(self) -> dict:
        return {"output": self.output_var.get(), "prefix": self.prefix_var.get(), "format": self.format_var.get(),
                "output_mode": self._output_mode(), "grid_size": self.grid_size_var.get(), "size_mode": self._size_mode(),
                "size_preset": self._size_preset(), "size_width": self.size_width_var.get(),
                "size_height": self.size_height_var.get(), "overwrite": self.overwrite_var.get()}
