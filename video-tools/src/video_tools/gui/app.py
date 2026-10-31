"""영상 이미지 추출·편집 GUI."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import queue
import threading
from pathlib import Path
from typing import Optional, Union
import tkinter as tk
from tkinter import filedialog, messagebox, ttk
import tkinter.font as tkfont

from video_tools.core.backend import OperationCancelled, VideoInfo
from video_tools.core.domain import SIZE_MODES, calculate_expected_output_count, resolve_size_plan, safe_prefix
from video_tools.core.edit import validate_edit
from video_tools.core.extraction import ExtractionRequest
from video_tools.core.limits import DURATION_TOLERANCE, VIDEO_EXTENSIONS
from video_tools.core.service import VideoService
from video_tools.gui.editor import EditingControls
from video_tools.gui.mcp_dialog import show_mcp_configuration
from video_tools.gui.options import APP_TITLE, CELL_SIZE_PRESETS, CUSTOM_SIZE_LABEL, DEFAULT_CELL_SIZE, DEFAULT_FINAL_SIZE, FINAL_SIZE_PRESETS, GRID_OUTPUT_MODE, GRID_SIZE_PRESETS, OUTPUT_MODES, PREVIEW_CANVAS_HEIGHT, format_time, parse_grid_layout, parse_positive_float, parse_positive_int, parse_time, resolve_preview_plan
from video_tools.gui.preview import PreviewCanvasRenderer
from video_tools.gui.settings import AppSettings, load_settings, save_settings
from video_tools.platforms import current


@dataclass(frozen=True)
class ProbeCompleted:
    video_path: Path
    duration: float
    info: VideoInfo


@dataclass(frozen=True)
class ProbeFailed:
    video_path: Path
    error: str


ProbeEvent = Union[ProbeCompleted, ProbeFailed]


class VideoToolsApp(tk.Tk):
    def __init__(self, settings_path: Path | None = None) -> None:
        super().__init__()
        self._settings_path = settings_path
        self.service = VideoService(workers=1)
        self.current_job = None
        self.video_info = None
        self.mode_var = tk.StringVar(self, value="extract")
        self.font_family = current.font_family or tkfont.nametofont("TkDefaultFont").actual("family")
        self.title(APP_TITLE)
        self.geometry("820x820")
        self.minsize(760, 760)
        self.configure(bg="#eef2f7")

        self.video_path: Optional[Path] = None
        self.duration: Optional[float] = None
        self.probe_worker: Optional[threading.Thread] = None
        self.probe_cancel_event = threading.Event()
        self.messages: queue.Queue[ProbeEvent] = queue.Queue()
        self._closing = False

        self.video_var = tk.StringVar()
        self.info_var = tk.StringVar(value="동영상 파일을 선택해 주세요.")
        self.start_var = tk.StringVar(value="00:00:00")
        self.end_var = tk.StringVar()
        # _load_settings fills these before the window is built.
        self.interval_var = tk.StringVar()
        self.output_var = tk.StringVar()
        self.prefix_var = tk.StringVar()
        self.format_var = tk.StringVar()
        self.output_mode_var = tk.StringVar()
        self.grid_size_var = tk.StringVar()
        self.size_mode_var = tk.StringVar()
        self.size_preset_var = tk.StringVar()
        self.size_width_var = tk.StringVar()
        self.size_height_var = tk.StringVar()
        self.overwrite_var = tk.BooleanVar()
        self.status_var = tk.StringVar(value="준비됨")
        self.progress_var = tk.DoubleVar(value=0)
        self.summary_var = tk.StringVar(value="출력 설정을 선택하면 예상 결과가 표시됩니다.")
        self.preview_info_var = tk.StringVar(value="현재 설정의 합성 샘플을 표시합니다.")
        self.preview_after_id: Optional[str] = None
        self.message_after_id: Optional[str] = None

        self._load_settings()
        self._build_style()
        self._build_ui()
        self.message_after_id = self.after(100, self._drain_messages)
        self.protocol("WM_DELETE_WINDOW", self._close)
        current.install_quit_handler(self, self._close)

    def _build_style(self) -> None:
        style = ttk.Style(self)
        try:
            style.theme_use(current.theme)
        except tk.TclError:
            pass
        style.configure("App.TFrame", background="#eef2f7")
        style.configure("Card.TFrame", background="#ffffff")
        style.configure("Title.TLabel", background="#eef2f7", foreground="#142033", font=(self.font_family, 23, "bold"))
        style.configure("Subtitle.TLabel", background="#eef2f7", foreground="#526174", font=(self.font_family, 10))
        style.configure("CardTitle.TLabel", background="#ffffff", foreground="#142033", font=(self.font_family, 12, "bold"))
        style.configure("CardText.TLabel", background="#ffffff", foreground="#475569", font=(self.font_family, 9))
        style.configure("Card.TEntry", fieldbackground="#ffffff", padding=(8, 6))
        style.configure("Card.TCombobox", padding=(6, 4))
        style.configure("Card.TCheckbutton", background="#ffffff", foreground="#334155")
        style.configure(
            "Accent.TButton",
            background="#2563eb",
            foreground="#ffffff",
            font=(self.font_family, 10, "bold"),
            padding=(16, 8),
        )
        style.map(
            "Accent.TButton",
            background=[("disabled", "#cbd5e1"), ("pressed", "#1e40af"), ("active", "#1d4ed8")],
            foreground=[("disabled", "#64748b"), ("!disabled", "#ffffff")],
        )
        style.configure("Secondary.TButton", padding=(12, 7))
        style.configure("Status.TLabel", background="#eef2f7", foreground="#526174", font=(self.font_family, 9))
        style.configure(
            "Summary.TLabel",
            background="#eff6ff",
            foreground="#1d4ed8",
            font=(self.font_family, 9, "bold"),
            padding=(10, 8),
        )
        style.configure(
            "SummaryError.TLabel",
            background="#fff1f2",
            foreground="#be123c",
            font=(self.font_family, 9, "bold"),
            padding=(10, 8),
        )

    def _build_ui(self) -> None:
        root = ttk.Frame(self, style="App.TFrame")
        root.pack(fill="both", expand=True)

        scroll_host = ttk.Frame(root, style="App.TFrame")
        scroll_host.pack(fill="both", expand=True)
        scroll_host.columnconfigure(0, weight=1)
        scroll_host.rowconfigure(0, weight=1)
        canvas = tk.Canvas(scroll_host, background="#eef2f7", highlightthickness=0, bd=0)
        canvas.grid(row=0, column=0, sticky="nsew")
        scrollbar = ttk.Scrollbar(scroll_host, orient="vertical", command=canvas.yview)
        scrollbar.grid(row=0, column=1, sticky="ns")
        canvas.configure(yscrollcommand=scrollbar.set)

        outer = ttk.Frame(canvas, style="App.TFrame", padding=(28, 16, 28, 14))
        content_window = canvas.create_window((0, 0), window=outer, anchor="nw")

        def update_scroll_region(_event: object = None) -> None:
            canvas.configure(scrollregion=canvas.bbox("all"))

        def fit_content_width(event: tk.Event) -> None:
            canvas.itemconfigure(content_window, width=event.width)

        outer.bind("<Configure>", update_scroll_region)
        canvas.bind("<Configure>", fit_content_width)
        # The scrollable content contains many native Tk widgets.  Bind the
        # wheel at the application level so scrolling works even when the
        # pointer is over an entry, combobox, or checkbutton inside the card.
        self.scroll_canvas = canvas
        def wheel(event):
            if event.widget.winfo_toplevel() == self:
                units = current.wheel_units(event.delta)
                if units: canvas.yview_scroll(units, "units")
                return 'break'
        self.scroll_tag = 'VideoToolsScroll' + self._w
        self.bind_class(self.scroll_tag, '<MouseWheel>', wheel)
        self.bind_class(self.scroll_tag, '<Button-4>', lambda event: (canvas.yview_scroll(-1, 'units'), 'break')[1])
        self.bind_class(self.scroll_tag, '<Button-5>', lambda event: (canvas.yview_scroll(1, 'units'), 'break')[1])
        current.bind_precise_scroll(self, self.scroll_tag, canvas)

        ttk.Label(outer, text=APP_TITLE, style="Title.TLabel").pack(anchor="w")
        ttk.Label(
            outer,
            text="필요한 순간을 이미지로 추출하거나, 영상의 구간·화면·속도·오디오를 편집합니다.",
            style="Subtitle.TLabel",
        ).pack(anchor="w", pady=(5, 12))
        tk.Frame(outer, height=3, bg="#2563eb", bd=0).pack(fill="x", pady=(0, 12))

        self._build_file_card(outer)
        self._build_range_card(outer)
        self.notebook = ttk.Notebook(outer)
        self.notebook.enable_traversal()
        self.notebook.pack(fill='both', expand=True, pady=(2, 12))
        self.extract_tab = ttk.Frame(self.notebook, style='App.TFrame')
        self.edit_tab = ttk.Frame(self.notebook, style='App.TFrame')
        self.notebook.add(self.extract_tab, text='이미지 추출')
        self.notebook.add(self.edit_tab, text='영상 편집')
        self._build_output_card(self.extract_tab)
        self._build_preview_card(self.extract_tab)
        self.editor = EditingControls(self, self.edit_tab, self._editing_settings)
        self.notebook.bind('<<NotebookTabChanged>>', self._mode_changed)
        def scrollable(widget):
            widget.bindtags((self.scroll_tag,) + widget.bindtags())
            for child in widget.winfo_children(): scrollable(child)
        scrollable(outer)
        canvas.bindtags((self.scroll_tag,) + canvas.bindtags())

        progress_area = ttk.Frame(root, style="App.TFrame", padding=(28, 8, 28, 14))
        progress_area.pack(fill="x")
        self.summary_label = ttk.Label(progress_area, textvariable=self.summary_var, style="Summary.TLabel", anchor="w", wraplength=690)
        self.summary_label.pack(fill="x", pady=(0, 7))
        self.update_output_summary()
        ttk.Label(progress_area, textvariable=self.status_var, style="Status.TLabel").pack(anchor="w")
        self.progress = ttk.Progressbar(progress_area, variable=self.progress_var, maximum=100)
        self.progress.pack(fill="x", pady=(7, 10))

        buttons = ttk.Frame(progress_area, style="App.TFrame")
        buttons.pack(fill="x")
        self.start_button = tk.Button(
            buttons,
            text="이미지 추출 시작",
            command=self._start,
            bg="#2563eb",
            fg="#ffffff",
            activebackground="#1d4ed8",
            activeforeground="#ffffff",
            disabledforeground="#64748b",
            relief="flat",
            bd=0,
            highlightthickness=0,
            font=(self.font_family, 10, "bold"),
            padx=18,
            pady=7,
            cursor="hand2",
        )
        self.start_button.pack(side="right")
        ttk.Button(buttons, text="MCP 연결 설정", command=lambda: show_mcp_configuration(self)).pack(side="left")
        self.cancel_button = ttk.Button(buttons, text="취소", style="Secondary.TButton", command=self._cancel, state="disabled")
        self.cancel_button.pack(side="right", padx=(0, 8), ipadx=8, ipady=4)
        self._schedule_preview_update()

    def card(self, parent: ttk.Frame) -> ttk.Frame:
        border = tk.Frame(parent, bg="#d8e1ec", bd=0, highlightthickness=0)
        border.pack(fill="x", pady=(0, 10))
        card = ttk.Frame(border, style="Card.TFrame", padding=(16, 12, 16, 14))
        card.pack(fill="x", padx=1, pady=1)
        return card

    def _build_file_card(self, parent: ttk.Frame) -> None:
        card = self.card(parent)
        ttk.Label(card, text="1. 동영상 파일", style="CardTitle.TLabel").grid(row=0, column=0, columnspan=2, sticky="w")
        ttk.Label(card, textvariable=self.info_var, style="CardText.TLabel").grid(
            row=1, column=0, columnspan=2, sticky="w", pady=(4, 9)
        )
        self.video_entry = ttk.Entry(card, textvariable=self.video_var, style="Card.TEntry", state="readonly")
        self.video_entry.grid(row=2, column=0, sticky="ew")
        self.video_button = ttk.Button(card, text="찾아보기", style="Secondary.TButton", command=self._choose_video)
        self.video_button.grid(row=2, column=1, padx=(10, 0))
        card.columnconfigure(0, weight=1)

    def _build_range_card(self, parent: ttk.Frame) -> None:
        card = self.card(parent)
        ttk.Label(card, text="2. 처리 구간", style="CardTitle.TLabel").grid(row=0, column=0, columnspan=3, sticky="w")
        ttk.Label(
            card,
            text="시간은 초 또는 HH:MM:SS 형식, 간격은 양의 실수 초 단위로 입력할 수 있습니다. 끝 시점은 포함하지 않습니다.",
            style="CardText.TLabel", wraplength=640,
        ).grid(row=1, column=0, columnspan=3, sticky="w", pady=(4, 10))
        ttk.Label(card, text="시작", style="CardText.TLabel").grid(row=2, column=0, sticky="w")
        self.start_entry = ttk.Entry(card, textvariable=self.start_var, width=18, style="Card.TEntry")
        self.start_entry.grid(row=3, column=0, sticky="ew", pady=(4, 0))
        ttk.Label(card, text="끝", style="CardText.TLabel").grid(row=2, column=1, sticky="w", padx=(12, 0))
        self.end_entry = ttk.Entry(card, textvariable=self.end_var, width=18, style="Card.TEntry")
        self.end_entry.grid(row=3, column=1, sticky="ew", padx=(12, 0), pady=(4, 0))
        ttk.Label(card, text="간격(초)", style="CardText.TLabel").grid(row=2, column=2, sticky="w", padx=(12, 0))
        self.interval_entry = ttk.Entry(card, textvariable=self.interval_var, width=14, style="Card.TEntry")
        self.interval_entry.grid(row=3, column=2, sticky="ew", padx=(12, 0), pady=(4, 0))
        for index in (0, 1, 2):
            card.columnconfigure(index, weight=1)

    def _build_output_card(self, parent: ttk.Frame) -> None:
        card = self.card(parent)
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
            values=OUTPUT_MODES,
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
            values=SIZE_MODES,
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
            self.start_var,
            self.end_var,
            self.interval_var,
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
        card = self.card(parent)
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
        self.preview_renderer = PreviewCanvasRenderer(self.preview_canvas, self.font_family)
        self.preview_canvas.grid(row=3, column=0, columnspan=4, sticky="ew", pady=(10, 0))
        self.preview_canvas.bind("<Configure>", lambda _event: self._schedule_preview_update())
        for index in range(4):
            card.columnconfigure(index, weight=1)

    def _on_output_mode_changed(self, _event: object = None) -> None:
        self._sync_output_controls()

    def _on_size_mode_changed(self, _event: object = None) -> None:
        available = self._available_size_presets()
        if self.size_preset_var.get() not in available:
            self.size_preset_var.set(self._default_size_preset())
        self._sync_size_controls()

    def _on_size_preset_changed(self, _event: object = None) -> None:
        self._sync_size_controls()

    def _on_summary_variable_changed(self, *_args: object) -> None:
        self.update_output_summary()
        self._schedule_preview_update()

    def _available_size_presets(self) -> dict[str, Optional[tuple[int, int]]]:
        if self.size_mode_var.get() == SIZE_MODES[0]:
            return {**FINAL_SIZE_PRESETS, CUSTOM_SIZE_LABEL: None}
        return {**CELL_SIZE_PRESETS, CUSTOM_SIZE_LABEL: None}

    def _default_size_preset(self) -> str:
        return DEFAULT_FINAL_SIZE if self.size_mode_var.get() == SIZE_MODES[0] else DEFAULT_CELL_SIZE

    def _sync_output_controls(self) -> None:
        if not hasattr(self, "grid_size_combo"):
            return
        state = "readonly" if self.output_mode_var.get() == GRID_OUTPUT_MODE else "disabled"
        self.grid_size_combo.configure(state=state)
        self.update_output_summary()

    def _sync_size_controls(self) -> None:
        if not hasattr(self, "size_preset_combo"):
            return
        if self.size_mode_var.get() not in SIZE_MODES:
            self.size_mode_var.set(SIZE_MODES[0])
        available = self._available_size_presets()
        self.size_preset_combo.configure(values=tuple(available.keys()), state="readonly")
        preset = self.size_preset_var.get()
        if preset not in available:
            preset = self._default_size_preset()
            self.size_preset_var.set(preset)

        selected_size = available[preset]
        if preset == CUSTOM_SIZE_LABEL:
            self.size_width_entry.configure(state="normal")
            self.size_height_entry.configure(state="normal")
            self.update_output_summary()
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
        self.update_output_summary()

    def _read_requested_size(self) -> Optional[tuple[int, int]]:
        preset = self.size_preset_var.get()
        available = self._available_size_presets()
        if preset not in available:
            raise ValueError("크기 프리셋을 선택해 주세요.")
        if preset == CUSTOM_SIZE_LABEL:
            return (
                parse_positive_int(self.size_width_var.get(), "너비"),
                parse_positive_int(self.size_height_var.get(), "높이"),
            )
        return available[preset]

    def update_output_summary(self) -> None:
        if self.mode_var.get() == 'edit' and hasattr(self, 'editor'):
            f = self.editor.fields
            self.summary_var.set(f'영상 편집 · {f["rotation"].get()}도 회전 · {f["speed"].get()}배속 · CRF {f["crf"].get()} · MP4')
            return
        if not hasattr(self, "summary_label"):
            return

        group_mode = self.output_mode_var.get() == GRID_OUTPUT_MODE
        grid_size = GRID_SIZE_PRESETS.get(self.grid_size_var.get(), (3, 3))
        effective_grid_size = grid_size if group_mode else (1, 1)
        try:
            requested_size = self._read_requested_size()
            size_plan = resolve_size_plan(
                self.size_mode_var.get(),
                requested_size,
                group_mode,
                effective_grid_size,
            )
        except ValueError as exc:
            self.summary_label.configure(style="SummaryError.TLabel")
            self.summary_var.set(f"설정을 확인하세요 · {exc}")
            return

        self.summary_label.configure(style="Summary.TLabel")
        if not group_mode:
            if size_plan.output_size is None:
                self.summary_var.set("예상 출력 · 개별 이미지 · 원본 크기")
            else:
                width, height = size_plan.output_size
                self.summary_var.set(f"예상 출력 · 개별 이미지 · {width} × {height}")
            return

        grid_label = self.grid_size_var.get()
        if size_plan.output_size is None:
            self.summary_var.set(f"예상 출력 · {grid_label} · 원본 셀 크기 · 최종 크기는 영상 기준")
            return

        output_width, output_height = size_plan.output_size
        if size_plan.frame_size is None:
            cell_text = "원본 셀 크기"
        else:
            cell_width, cell_height = size_plan.frame_size
            cell_text = f"셀 {cell_width} × {cell_height}"
        self.summary_var.set(
            f"예상 출력 · {grid_label} · {cell_text} · 최종 {output_width} × {output_height}"
        )

    def _schedule_preview_update(self, *_args: object) -> None:
        """설정 변경을 한 번 모아 미리보기를 갱신한다."""

        if not hasattr(self, "preview_canvas"):
            return
        if self.preview_after_id is not None:
            try:
                self.after_cancel(self.preview_after_id)
            except (tk.TclError, ValueError):
                pass
        self.preview_after_id = self.after_idle(self._render_preview)

    def _render_preview(self) -> None:
        """현재 설정을 반영한 합성 샘플 한 장을 그린다."""

        self.preview_after_id = None
        if not hasattr(self, "preview_canvas"):
            return

        group_mode = self.output_mode_var.get() == GRID_OUTPUT_MODE
        grid_size = GRID_SIZE_PRESETS.get(self.grid_size_var.get(), (3, 3))
        try:
            requested_size = self._read_requested_size()
            preview_plan = resolve_preview_plan(
                self.size_mode_var.get(),
                requested_size,
                group_mode,
                grid_size,
            )
            start = parse_time(self.start_var.get())
            interval = parse_positive_float(self.interval_var.get(), "추출 간격")
            end_text = self.end_var.get().strip()
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

    def _choose_video(self) -> None:
        selected = filedialog.askopenfilename(
            title="동영상 선택",
            filetypes=(("MP4 동영상", "*.mp4"), ("동영상 파일", tuple(f"*{extension}" for extension in VIDEO_EXTENSIONS)), ("모든 파일", "*.*")),
        )
        if not selected:
            return

        path = Path(selected)
        self.video_path = path
        self.duration = None
        self.start_var.set("00:00:00")
        self.video_var.set(str(path))
        self.info_var.set("영상 정보를 분석하는 중...")
        self.start_button.configure(state="disabled")
        self.video_button.configure(state="disabled")
        self.status_var.set("동영상 정보를 읽는 중...")
        self.probe_cancel_event.clear()
        self.probe_worker = threading.Thread(
            target=self._probe_worker,
            args=(path, self.probe_cancel_event),
            daemon=True,
        )
        self.probe_worker.start()

    def _probe_worker(self, path: Path, cancel_event: threading.Event) -> None:
        try:
            info = self.service.inspect(path, cancel_event)
            if cancel_event.is_set():
                return
            self.messages.put(ProbeCompleted(path, info.duration, info))
        except OperationCancelled:
            return
        except Exception as exc:
            if not cancel_event.is_set():
                self.messages.put(ProbeFailed(path, str(exc)))

    def _choose_output(self) -> None:
        selected = filedialog.askdirectory(title="이미지 저장 폴더 선택")
        if selected:
            self.output_var.set(selected)

    def _start_extraction(self) -> None:
        if self.current_job:
            return
        if not self.video_path or not self.video_path.exists():
            messagebox.showwarning(APP_TITLE, "먼저 동영상 파일을 선택해 주세요.")
            return
        if not self.duration:
            messagebox.showwarning(APP_TITLE, "동영상 정보를 아직 읽는 중입니다. 잠시 후 다시 시도해 주세요.")
            return

        try:
            start = parse_time(self.start_var.get())
            end = parse_time(self.end_var.get())
            if start >= end:
                raise ValueError("끝 시간은 시작 시간보다 커야 합니다.")
            if end > self.duration + DURATION_TOLERANCE:
                raise ValueError(f"끝 시간은 영상 길이({format_time(self.duration)})를 넘을 수 없습니다.")
            interval = parse_positive_float(self.interval_var.get(), "추출 간격")
            group_mode = self.output_mode_var.get() == GRID_OUTPUT_MODE
            grid_size = parse_grid_layout(self.grid_size_var.get())
            effective_grid_size = grid_size if group_mode else (1, 1)
            requested_size = self._read_requested_size()
            size_plan = resolve_size_plan(
                self.size_mode_var.get(),
                requested_size,
                group_mode,
                effective_grid_size,
            )
            output_text = self.output_var.get().strip()
            if not output_text:
                raise ValueError("저장 폴더를 입력해 주세요.")
            output_dir = Path(output_text).expanduser().resolve()
            output_dir.mkdir(parents=True, exist_ok=True)
            prefix = safe_prefix(self.prefix_var.get(), self.video_path.stem + "_frame")
        except (OSError, ValueError) as exc:
            messagebox.showerror(APP_TITLE, str(exc))
            return

        extension = "png" if self.format_var.get().upper() == "PNG" else "jpg"
        expected = calculate_expected_output_count(start, end, interval, group_mode, effective_grid_size)
        request = ExtractionRequest(
            video_path=self.video_path,
            output_dir=output_dir,
            prefix=prefix,
            extension=extension,
            start=start,
            end=end,
            interval=interval,
            overwrite=self.overwrite_var.get(),
            group_mode=group_mode,
            grid_size=effective_grid_size,
            size_plan=size_plan,
        )
        self.current_job = self.service.start_extraction(request)['job_id']
        self.progress_var.set(0)
        self.status_var.set(f'이미지 추출 시작 · 예상 {expected}장')
        self._set_controls('disabled')
        self.cancel_button.configure(state='normal')

    def _drain_messages(self) -> None:
        if self._closing: return
        try:
            while True:
                event = self.messages.get_nowait()
                if isinstance(event, ProbeCompleted) and event.video_path == self.video_path:
                    self.duration, self.video_info = event.duration, event.info
                    self.end_var.set(format_time(event.duration))
                    self.prefix_var.set(f'{event.video_path.stem}_frame')
                    if event.info:
                        width, height = event.info.display_size
                        self.info_var.set(f'길이 {format_time(event.duration)} · {width} × {height} · {event.info.fps:g} FPS')
                        self.editor.source_changed(event.info)
                    self.status_var.set('처리 구간과 저장 설정을 확인해 주세요.')
                    self.start_button.configure(state='normal')
                    self.video_button.configure(state='normal')
                elif isinstance(event, ProbeFailed) and event.video_path == self.video_path:
                    self.info_var.set('영상 정보를 읽지 못했습니다.')
                    self.status_var.set('오류')
                    self.start_button.configure(state='disabled')
                    self.video_button.configure(state='normal')
                    messagebox.showerror(APP_TITLE, event.error)
        except queue.Empty:
            pass
        if self.current_job:
            job = self.service.job(self.current_job)
            self.progress_var.set(job['progress_percent'])
            label = '영상 편집' if job['kind'] == 'edit_video' else '이미지 추출'
            self.status_var.set(f'{label} · {job["progress_percent"]:.0f}%')
            if job['status'] in {'completed', 'failed', 'cancelled'}:
                self.current_job = None
                self._set_controls('normal')
                self.cancel_button.configure(state='disabled')
                if job['status'] == 'completed':
                    result = job['result']
                    if job['kind'] == 'edit_video':
                        self.status_var.set('영상 편집 완료')
                        messagebox.showinfo(APP_TITLE, f'편집 영상을 저장했습니다.\n{result["output_path"]}\n{result["width"]} × {result["height"]} · {result["duration"]:g}초')
                    else:
                        self.status_var.set(f'완료 · {result["saved_count"]}장 저장됨')
                        messagebox.showinfo(APP_TITLE, f'이미지 {result["saved_count"]}장 저장 · 기존 파일 {result["skipped_count"]}장 건너뜀\n{result["output_directory"]}')
                elif job['status'] == 'failed':
                    self.status_var.set('오류')
                    messagebox.showerror(APP_TITLE, job['error'])
                else:
                    self.status_var.set('취소됨'); self.progress_var.set(0)
        if not self._closing:
            self.message_after_id = self.after(100, self._drain_messages)

    def _set_controls(self, state: str) -> None:
        self.editor.sync(state == 'normal')
        for index in range(2): self.notebook.tab(index, state='normal' if state == 'normal' else 'disabled')
        for widget in (
            self.video_entry,
            self.video_button,
            self.start_entry,
            self.end_entry,
            self.interval_entry,
            self.output_entry,
            self.output_button,
            self.prefix_entry,
            self.format_combo,
            self.output_mode_combo,
            self.grid_size_combo,
            self.size_mode_combo,
            self.size_preset_combo,
            self.size_width_entry,
            self.size_height_entry,
            self.overwrite_check,
            self.start_button,
        ):
            try:
                widget.configure(state=state)
            except tk.TclError:
                pass
        if state == "normal":
            self.video_entry.configure(state="readonly")
            for combo in (self.format_combo, self.output_mode_combo, self.size_mode_combo):
                combo.configure(state="readonly")
            self._sync_output_controls()
            self._sync_size_controls()
            if self.mode_var.get() == "edit": self.interval_entry.configure(state="disabled")

    def _cancel(self) -> None:
        if self.current_job:
            self.service.cancel_job(self.current_job)
            self.cancel_button.configure(state='disabled')
            self.status_var.set('취소하는 중...')

    def _close(self) -> None:
        if not self._closing:
            self._closing = True
            self.probe_cancel_event.set()
            self.service.close(wait=False)
        self.service.stop_processes()
        running = any(job['status'] not in {'completed', 'failed', 'cancelled'} for job in self.service.list_jobs())
        if running or (self.probe_worker and self.probe_worker.is_alive()):
            self.after(100, self._close)
            return
        for after_id in (self.message_after_id, self.preview_after_id):
            if after_id:
                try: self.after_cancel(after_id)
                except tk.TclError: pass
        self._save_settings()
        self.destroy()

    def _load_settings(self) -> None:
        settings = load_settings(self._settings_path)
        self._editing_settings = settings.editing
        for variable, value in (
            (self.output_var, settings.output),
            (self.prefix_var, settings.prefix),
            (self.format_var, settings.format),
            (self.interval_var, settings.interval),
            (self.output_mode_var, settings.output_mode),
            (self.grid_size_var, settings.grid_size),
            (self.size_mode_var, settings.size_mode),
            (self.size_preset_var, settings.size_preset),
            (self.size_width_var, settings.size_width),
            (self.size_height_var, settings.size_height),
        ):
            variable.set(value)
        self.overwrite_var.set(settings.overwrite)
        if settings.geometry:
            try:
                self.geometry(settings.geometry)
            except tk.TclError:
                pass

    def _save_settings(self) -> None:
        save_settings(
            AppSettings(
                output=self.output_var.get(),
                prefix=self.prefix_var.get(),
                format=self.format_var.get(),
                interval=self.interval_var.get(),
                output_mode=self.output_mode_var.get(),
                grid_size=self.grid_size_var.get(),
                size_mode=self.size_mode_var.get(),
                size_preset=self.size_preset_var.get(),
                size_width=self.size_width_var.get(),
                size_height=self.size_height_var.get(),
                overwrite=self.overwrite_var.get(),
                geometry=self.geometry(),
                editing=self.editor.settings(),
            ), self._settings_path
        )

    def _mode_changed(self, _event=None):
        if self._closing or not self.notebook.select():
            return
        self.mode_var.set('edit' if self.notebook.index(self.notebook.select()) == 1 else 'extract')
        self.start_button.configure(text='영상 편집 시작' if self.mode_var.get() == 'edit' else '이미지 추출 시작')
        self.interval_entry.configure(state='disabled' if self.mode_var.get() == 'edit' else 'normal')
        self.scroll_canvas.yview_moveto(0)
        self.update_output_summary()

    def _start(self):
        if self.mode_var.get() == 'edit': self._start_edit()
        else: self._start_extraction()

    def _start_edit(self):
        if self.current_job: return
        if not self.video_path or not self.video_info:
            messagebox.showwarning(APP_TITLE, '먼저 동영상 파일을 선택하고 정보 조회가 끝날 때까지 기다리세요.')
            return
        try:
            request = self.editor.request(self.video_path, parse_time(self.start_var.get()), parse_time(self.end_var.get()))
            validate_edit(request, self.video_info)
            self.current_job = self.service.start_edit(request)['job_id']
        except (ValueError, OSError) as exc:
            messagebox.showerror(APP_TITLE, str(exc))
            return
        self.progress_var.set(0)
        self.status_var.set('영상 편집 시작')
        self._set_controls('disabled')
        self.cancel_button.configure(state='normal')


def main():
    parser = argparse.ArgumentParser(description='영상 이미지 추출 및 편집 GUI')
    parser.add_argument('--settings', type=Path, help='Optional isolated settings file')
    args = parser.parse_args()
    try:
        app = VideoToolsApp(args.settings)
        app.mainloop()
    except Exception as exc:
        messagebox.showerror(APP_TITLE, str(exc))
        return 1
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
