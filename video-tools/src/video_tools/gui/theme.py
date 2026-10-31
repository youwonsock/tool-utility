"""Shared ttk styles and card layout for the GUI."""

from __future__ import annotations

import tkinter as tk
from tkinter import ttk

from video_tools.platforms import current


def apply_style(root: tk.Tk, font_family: str) -> None:
    style = ttk.Style(root)
    try:
        style.theme_use(current.theme)
    except tk.TclError:
        pass
    style.configure("App.TFrame", background="#eef2f7")
    style.configure("Card.TFrame", background="#ffffff")
    style.configure("Title.TLabel", background="#eef2f7", foreground="#142033", font=(font_family, 23, "bold"))
    style.configure("Subtitle.TLabel", background="#eef2f7", foreground="#526174", font=(font_family, 10))
    style.configure("CardTitle.TLabel", background="#ffffff", foreground="#142033", font=(font_family, 12, "bold"))
    style.configure("CardText.TLabel", background="#ffffff", foreground="#475569", font=(font_family, 9))
    style.configure("Card.TEntry", fieldbackground="#ffffff", padding=(8, 6))
    style.configure("Card.TCombobox", padding=(6, 4))
    style.configure("Card.TCheckbutton", background="#ffffff", foreground="#334155")
    style.configure(
        "Accent.TButton",
        background="#2563eb",
        foreground="#ffffff",
        font=(font_family, 10, "bold"),
        padding=(16, 8),
    )
    style.map(
        "Accent.TButton",
        background=[("disabled", "#cbd5e1"), ("pressed", "#1e40af"), ("active", "#1d4ed8")],
        foreground=[("disabled", "#64748b"), ("!disabled", "#ffffff")],
    )
    style.configure("Secondary.TButton", padding=(12, 7))
    style.configure("Status.TLabel", background="#eef2f7", foreground="#526174", font=(font_family, 9))
    style.configure(
        "Summary.TLabel",
        background="#eff6ff",
        foreground="#1d4ed8",
        font=(font_family, 9, "bold"),
        padding=(10, 8),
    )
    style.configure(
        "SummaryError.TLabel",
        background="#fff1f2",
        foreground="#be123c",
        font=(font_family, 9, "bold"),
        padding=(10, 8),
    )


def card(parent: ttk.Frame) -> ttk.Frame:
    border = tk.Frame(parent, bg="#d8e1ec", bd=0, highlightthickness=0)
    border.pack(fill="x", pady=(0, 10))
    card = ttk.Frame(border, style="Card.TFrame", padding=(16, 12, 16, 14))
    card.pack(fill="x", padx=1, pady=1)
    return card
