"""Shared Tk editing controls and portable MCP configuration dialog."""
from dataclasses import asdict
import json
from pathlib import Path
import tkinter as tk
from tkinter import ttk, filedialog, messagebox

from video_tools.core.edit import EditRequest
from video_tools.core.settings import EditingSettings
from video_tools.runtime import configuration


class EditingControls:
    def __init__(self, app, parent, settings: EditingSettings):
        self.app = app
        self.widgets = []
        self.fields = {key: (tk.BooleanVar(app, value=value) if isinstance(value, bool) else tk.StringVar(app, value=value))
                       for key, value in asdict(settings).items()}
        card = app._card(parent)
        ttk.Label(card, text="3. 편집 결과", style="CardTitle.TLabel").grid(row=0, column=0, columnspan=4, sticky='w')
        ttk.Label(card, text="H.264 / AAC MP4로 저장합니다. 원본과 다른 경로를 선택하세요.",
                  style='CardText.TLabel', wraplength=600).grid(row=1, column=0, columnspan=4, sticky='w', pady=(5, 10))
        self.output_entry = ttk.Entry(card, textvariable=self.fields['output'], style='Card.TEntry')
        self.output_entry.grid(row=2, column=0, columnspan=3, sticky='ew')
        browse = ttk.Button(card, text="저장 위치", command=self.choose_output)
        browse.grid(row=2, column=3, padx=(10, 0))
        self.widgets += [self.output_entry, browse]
        self.check(card, 'overwrite', '기존 결과 덮어쓰기', 3, 0)
        for c in range(4): card.columnconfigure(c, weight=1)

        card = app._card(parent)
        self.check(card, 'crop_enabled', '크롭 사용', 0, 0)
        ttk.Label(card, text="자동 회전 적용 후 영상의 픽셀 좌표입니다. X·Y는 왼쪽 위에서 시작합니다.",
                  style='CardText.TLabel', wraplength=600).grid(row=1, column=0, columnspan=4, sticky='w', pady=(4, 8))
        self.crop_entries = [self.entry(card, key, label, 2, column) for column, (key, label) in enumerate(
            [('crop_x', 'X'), ('crop_y', 'Y'), ('crop_width', '너비'), ('crop_height', '높이')])]
        for c in range(4): card.columnconfigure(c, weight=1)

        card = app._card(parent)
        ttk.Label(card, text="회전·반전", style='CardTitle.TLabel').grid(row=0, column=0, sticky='w')
        self.rotation = ttk.Combobox(card, textvariable=self.fields['rotation'], values=('0', '90', '180', '270'), state='readonly', width=10)
        self.rotation.grid(row=1, column=0, sticky='w', pady=(8, 0))
        ttk.Label(card, text="시계 방향 (도)", style='CardText.TLabel').grid(row=1, column=1, sticky='w', padx=8)
        self.check(card, 'flip_horizontal', '가로 반전', 1, 2)
        self.check(card, 'flip_vertical', '세로 반전', 1, 3)
        self.widgets.append(self.rotation)
        for c in range(4): card.columnconfigure(c, weight=1)

        card = app._card(parent)
        self.check(card, 'resize_enabled', '출력 크기 지정', 0, 0)
        ttk.Label(card, text="비율을 유지하고 남는 공간은 여백으로 채웁니다. 너비·높이는 짝수로 입력하세요.",
                  style='CardText.TLabel', wraplength=600).grid(row=1, column=0, columnspan=4, sticky='w', pady=(4, 8))
        self.resize_entries = [self.entry(card, 'width', '너비(px)', 2, 0), self.entry(card, 'height', '높이(px)', 2, 1)]
        for c in range(2): card.columnconfigure(c, weight=1)

        card = app._card(parent)
        ttk.Label(card, text="속도·오디오·화질", style='CardTitle.TLabel').grid(row=0, column=0, columnspan=3, sticky='w')
        self.entry(card, 'speed', '배속 (0.25~4)', 1, 0)
        self.entry(card, 'crf', 'CRF (0~51, 낮을수록 고화질)', 1, 1)
        self.check(card, 'mute', '음소거', 2, 2)
        for c in range(3): card.columnconfigure(c, weight=1)
        for variable in self.fields.values(): variable.trace_add('write', self.changed)
        self.sync()

    def entry(self, parent, key, label, row, column):
        ttk.Label(parent, text=label, style='CardText.TLabel', wraplength=240).grid(row=row, column=column, sticky='w', padx=(0, 12))
        widget = ttk.Entry(parent, textvariable=self.fields[key], style='Card.TEntry', width=12)
        widget.grid(row=row + 1, column=column, sticky='ew', padx=(0, 12), pady=(4, 0))
        self.widgets.append(widget)
        return widget

    def check(self, parent, key, label, row, column):
        widget = ttk.Checkbutton(parent, text=label, variable=self.fields[key], style='Card.TCheckbutton')
        widget.grid(row=row, column=column, sticky='w', pady=8)
        self.widgets.append(widget)

    def changed(self, *_):
        self.sync(enabled=not self.app.current_job)
        self.app._update_output_summary()

    def sync(self, enabled=True):
        for widget in self.widgets: widget.configure(state='normal' if enabled else 'disabled')
        self.rotation.configure(state='readonly' if enabled else 'disabled')
        for widget in self.crop_entries:
            widget.configure(state='normal' if enabled and self.fields['crop_enabled'].get() else 'disabled')
        for widget in self.resize_entries:
            widget.configure(state='normal' if enabled and self.fields['resize_enabled'].get() else 'disabled')

    def choose_output(self):
        initial = self.fields['output'].get() or str(Path(self.app.output_var.get()) / 'edited.mp4')
        chosen = filedialog.asksaveasfilename(parent=self.app, title='편집 영상 저장', defaultextension='.mp4',
                    filetypes=(('MP4 영상', '*.mp4'),), initialdir=str(Path(initial).parent), initialfile=Path(initial).name)
        if chosen: self.fields['output'].set(chosen)

    def source_changed(self, info):
        if not self.fields['output'].get():
            self.fields['output'].set(str(Path(self.app.output_var.get()) / (info.path.stem + '_edited.mp4')))
        if not self.fields['crop_enabled'].get():
            self.fields['crop_width'].set(str(info.display_size[0]))
            self.fields['crop_height'].set(str(info.display_size[1]))

    def request(self, start, end):
        f = self.fields
        output = f['output'].get().strip()
        if not output: raise ValueError('편집 결과의 저장 경로를 지정하세요.')
        crop = tuple(int(f[key].get()) for key in ('crop_x', 'crop_y', 'crop_width', 'crop_height')) if f['crop_enabled'].get() else None
        width, height = (int(f['width'].get()), int(f['height'].get())) if f['resize_enabled'].get() else (None, None)
        return EditRequest(self.app.service.ffmpeg, self.app.video_path, Path(output).expanduser().resolve(),
            start, end, width, height, crop, int(f['rotation'].get()), f['flip_horizontal'].get(),
            f['flip_vertical'].get(), float(f['speed'].get()), f['mute'].get(), f['overwrite'].get(), int(f['crf'].get()))

    def settings(self):
        return EditingSettings(**{key: value.get() for key, value in self.fields.items()})


def show_mcp_configuration(app):
    dialog = tk.Toplevel(app)
    dialog.title('MCP 연결 설정')
    dialog.geometry('760x510')
    dialog.minsize(600, 430)
    dialog.transient(app)
    body = ttk.Frame(dialog, padding=20)
    body.pack(fill='both', expand=True)
    body.columnconfigure(0, weight=1)
    body.rowconfigure(5, weight=1)
    workspace = tk.StringVar(dialog)
    ttk.Label(body, text='영상 작업 폴더를 선택한 뒤 생성한 JSON을 MCP 클라이언트 설정에 등록하세요.', wraplength=660).grid(row=0, column=0, columnspan=2, sticky='w')
    ttk.Entry(body, textvariable=workspace).grid(row=1, column=0, sticky='ew', pady=12)
    def choose_workspace():
        path = filedialog.askdirectory(parent=dialog, title='MCP 작업 폴더')
        if path: workspace.set(path)
    ttk.Button(body, text='작업 폴더 선택', command=choose_workspace).grid(row=1, column=1, padx=(10, 0))
    ttk.Label(body, text='생성한 설정은 현재 도구 폴더를 사용합니다. 폴더를 옮겼다면 설정을 다시 생성하세요.', wraplength=660).grid(row=2, column=0, columnspan=2, sticky='w')
    ttk.Label(body, text='클라이언트 연결 설정은 사용하는 앱에 별도로 등록해야 합니다.', wraplength=660).grid(row=4, column=0, columnspan=2, sticky='w')
    text = tk.Text(body, wrap='word', font='TkFixedFont', height=10)
    text.grid(row=5, column=0, columnspan=2, sticky='nsew', pady=12)
    def generate():
        try:
            if not workspace.get().strip(): raise ValueError('MCP 작업 폴더를 선택하세요.')
            value = configuration(Path(workspace.get()))
            content = json.dumps(value, ensure_ascii=False, indent=2)
            text.delete('1.0', 'end'); text.insert('1.0', content)
            return content
        except (ValueError, OSError) as exc:
            messagebox.showerror('MCP 연결 설정', str(exc), parent=dialog)
    def copy():
        content = generate()
        if content:
            dialog.clipboard_clear(); dialog.clipboard_append(content)
    def save():
        content = generate()
        if content:
            path = filedialog.asksaveasfilename(parent=dialog, defaultextension='.json', initialfile='mcp-config.local.json')
            if path: Path(path).write_text(content + '\n', encoding='utf-8')
    buttons = ttk.Frame(body); buttons.grid(row=6, column=0, columnspan=2, sticky='e')
    for label, command in [('설정 생성', generate), ('복사', copy), ('파일 저장', save)]:
        ttk.Button(buttons, text=label, command=command).pack(side='left', padx=4)
