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

from video_tools.core.edit import validate_edit
from video_tools.core.limits import DURATION_TOLERANCE, VIDEO_EXTENSIONS
from video_tools.core.probe import VideoInfo
from video_tools.core.process import OperationCancelled
from video_tools.core.service import VideoService
from video_tools.gui import theme
from video_tools.gui.editor import EditingControls
from video_tools.gui.mcp_dialog import show_mcp_configuration
from video_tools.gui.extract_tab import ExtractionControls
from video_tools.gui.options import APP_TITLE, format_time, parse_positive_float, parse_time
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
        self.interval_var = tk.StringVar()
        self.status_var = tk.StringVar(value="준비됨")
        self.progress_var = tk.DoubleVar(value=0)
        self.summary_var = tk.StringVar(value="출력 설정을 선택하면 예상 결과가 표시됩니다.")
        self.message_after_id: Optional[str] = None

        self._load_settings()
        theme.apply_style(self, self.font_family)
        self._build_ui()
        self.message_after_id = self.after(100, self._drain_messages)
        self.protocol("WM_DELETE_WINDOW", self._close)
        current.install_quit_handler(self, self._close)

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
        self.extraction = ExtractionControls(self, self.extract_tab, self._settings)
        self.editor = EditingControls(self, self.edit_tab, self._settings.editing)
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
        # tk.Button ignores its background on macOS, which left white text on a white button.
        self.start_button = ttk.Button(buttons, text="이미지 추출 시작", style="Accent.TButton", command=self._start, cursor="hand2")
        self.start_button.pack(side="right")
        ttk.Button(buttons, text="MCP 연결 설정", command=lambda: show_mcp_configuration(self)).pack(side="left")
        self.cancel_button = ttk.Button(buttons, text="취소", style="Secondary.TButton", command=self._cancel, state="disabled")
        self.cancel_button.pack(side="right", padx=(0, 8), ipadx=8, ipady=4)
        self.extraction._schedule_preview_update()

    def _build_file_card(self, parent: ttk.Frame) -> None:
        card = theme.card(parent)
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
        card = theme.card(parent)
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

    def update_output_summary(self) -> None:
        if self.mode_var.get() == 'edit' and hasattr(self, 'editor'):
            f = self.editor.fields
            self.summary_var.set(f'영상 편집 · {f["rotation"].get()}도 회전 · {f["speed"].get()}배속 · CRF {f["crf"].get()} · MP4')
            return
        if not hasattr(self, "summary_label"):
            return
        text, failed = self.extraction.summary()
        self.summary_label.configure(style="SummaryError.TLabel" if failed else "Summary.TLabel")
        self.summary_var.set(text)

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
            request, expected = self.extraction.request(self.video_path, start, end, interval)
        except (OSError, ValueError) as exc:
            messagebox.showerror(APP_TITLE, str(exc))
            return

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
                    self.extraction.prefix_var.set(f'{event.video_path.stem}_frame')
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
        # A disabled selected tab unmaps its panel, and enabling it again does not bring the panel back.
        selected = self.notebook.select()
        for tab in self.notebook.tabs():
            self.notebook.tab(tab, state='normal' if state == 'normal' or tab == selected else 'disabled')
        for widget in (self.video_entry, self.video_button, self.start_entry, self.end_entry, self.interval_entry, self.start_button):
            widget.configure(state=state)
        self.extraction.set_enabled(state)
        if state == "normal":
            self.video_entry.configure(state="readonly")
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
        for after_id in (self.message_after_id, self.extraction.preview_after_id):
            if after_id:
                try: self.after_cancel(after_id)
                except tk.TclError: pass
        self._save_settings()
        self.destroy()

    def _load_settings(self) -> None:
        self._settings = load_settings(self._settings_path)
        self.interval_var.set(self._settings.interval)
        if self._settings.geometry:
            try:
                self.geometry(self._settings.geometry)
            except tk.TclError:
                pass

    def _save_settings(self) -> None:
        save_settings(
            AppSettings(
                interval=self.interval_var.get(),
                geometry=self.geometry(),
                editing=self.editor.settings(),
                **self.extraction.settings_values(),
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
