"""Tk controls for the video editing tab."""
from dataclasses import asdict
from pathlib import Path
import tkinter as tk
from tkinter import ttk, filedialog

from video_tools.core.edit import EditRequest
from video_tools.core.limits import MAX_CRF, MAX_SPEED, MIN_SPEED, ROTATIONS
from video_tools.gui import theme
from video_tools.gui.settings import EditingSettings


class EditingControls:
    def __init__(self, app, parent, settings: EditingSettings):
        self.app = app
        self.widgets = []
        self.fields = {key: (tk.BooleanVar(app, value=value) if isinstance(value, bool) else tk.StringVar(app, value=value))
                       for key, value in asdict(settings).items()}
        card = theme.card(parent)
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

        card = theme.card(parent)
        self.check(card, 'crop_enabled', '크롭 사용', 0, 0)
        ttk.Label(card, text="자동 회전 적용 후 영상의 픽셀 좌표입니다. X·Y는 왼쪽 위에서 시작합니다.",
                  style='CardText.TLabel', wraplength=600).grid(row=1, column=0, columnspan=4, sticky='w', pady=(4, 8))
        self.crop_entries = [self.entry(card, key, label, 2, column) for column, (key, label) in enumerate(
            [('crop_x', 'X'), ('crop_y', 'Y'), ('crop_width', '너비'), ('crop_height', '높이')])]
        for c in range(4): card.columnconfigure(c, weight=1)

        card = theme.card(parent)
        ttk.Label(card, text="회전·반전", style='CardTitle.TLabel').grid(row=0, column=0, sticky='w')
        self.rotation = ttk.Combobox(card, textvariable=self.fields['rotation'], values=tuple(map(str, ROTATIONS)), state='readonly', width=10)
        self.rotation.grid(row=1, column=0, sticky='w', pady=(8, 0))
        ttk.Label(card, text="시계 방향 (도)", style='CardText.TLabel').grid(row=1, column=1, sticky='w', padx=8)
        self.check(card, 'flip_horizontal', '가로 반전', 1, 2)
        self.check(card, 'flip_vertical', '세로 반전', 1, 3)
        self.widgets.append(self.rotation)
        for c in range(4): card.columnconfigure(c, weight=1)

        card = theme.card(parent)
        self.check(card, 'resize_enabled', '출력 크기 지정', 0, 0)
        ttk.Label(card, text="비율을 유지하고 남는 공간은 여백으로 채웁니다. 너비·높이는 짝수로 입력하세요.",
                  style='CardText.TLabel', wraplength=600).grid(row=1, column=0, columnspan=4, sticky='w', pady=(4, 8))
        self.resize_entries = [self.entry(card, 'width', '너비(px)', 2, 0), self.entry(card, 'height', '높이(px)', 2, 1)]
        for c in range(2): card.columnconfigure(c, weight=1)

        card = theme.card(parent)
        ttk.Label(card, text="속도·오디오·화질", style='CardTitle.TLabel').grid(row=0, column=0, columnspan=3, sticky='w')
        self.entry(card, 'speed', f'배속 ({MIN_SPEED:g}~{MAX_SPEED:g})', 1, 0)
        self.entry(card, 'crf', f'CRF (0~{MAX_CRF}, 낮을수록 고화질)', 1, 1)
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
        self.app.update_output_summary()

    def sync(self, enabled=True):
        for widget in self.widgets: widget.configure(state='normal' if enabled else 'disabled')
        self.rotation.configure(state='readonly' if enabled else 'disabled')
        for widget in self.crop_entries:
            widget.configure(state='normal' if enabled and self.fields['crop_enabled'].get() else 'disabled')
        for widget in self.resize_entries:
            widget.configure(state='normal' if enabled and self.fields['resize_enabled'].get() else 'disabled')

    def choose_output(self):
        initial = self.fields['output'].get() or str(Path(self.app.extraction.output_var.get()) / 'edited.mp4')
        chosen = filedialog.asksaveasfilename(parent=self.app, title='편집 영상 저장', defaultextension='.mp4',
                    filetypes=(('MP4 영상', '*.mp4'),), initialdir=str(Path(initial).parent), initialfile=Path(initial).name)
        if chosen: self.fields['output'].set(chosen)

    def source_changed(self, info):
        if not self.fields['output'].get():
            self.fields['output'].set(str(Path(self.app.extraction.output_var.get()) / (info.path.stem + '_edited.mp4')))
        if not self.fields['crop_enabled'].get():
            self.fields['crop_width'].set(str(info.display_size[0]))
            self.fields['crop_height'].set(str(info.display_size[1]))

    def request(self, video_path, start, end):
        f = self.fields
        output = f['output'].get().strip()
        if not output: raise ValueError('편집 결과의 저장 경로를 지정하세요.')
        crop = tuple(int(f[key].get()) for key in ('crop_x', 'crop_y', 'crop_width', 'crop_height')) if f['crop_enabled'].get() else None
        width, height = (int(f['width'].get()), int(f['height'].get())) if f['resize_enabled'].get() else (None, None)
        return EditRequest(video_path=video_path, output_path=Path(output).expanduser().resolve(),
            start=start, end=end, width=width, height=height, crop=crop, rotation=int(f['rotation'].get()),
            flip_horizontal=f['flip_horizontal'].get(), flip_vertical=f['flip_vertical'].get(),
            speed=float(f['speed'].get()), mute=f['mute'].get(), overwrite=f['overwrite'].get(), crf=int(f['crf'].get()))

    def settings(self):
        return EditingSettings(**{key: value.get() for key, value in self.fields.items()})
