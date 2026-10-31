"""MCP client configuration dialog for this tool folder."""
import json
from pathlib import Path
import tkinter as tk
from tkinter import ttk, filedialog, messagebox

from video_tools.runtime import configuration


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
