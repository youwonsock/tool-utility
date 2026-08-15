"""합성 미리보기 Canvas 렌더러."""

from __future__ import annotations

import tkinter as tk

from video_to_image_domain import (
    GRID_MARGIN,
    GRID_PADDING,
    PREVIEW_INSET,
    PREVIEW_SAMPLE_COLORS,
    PreviewPlan,
    format_time,
)


class PreviewCanvasRenderer:
    """PreviewPlan을 Tkinter Canvas에 그리는 UI 전용 객체."""

    def __init__(self, canvas: tk.Canvas) -> None:
        self.canvas = canvas

    def draw_message(self, message: str) -> None:
        self.canvas.configure(background="#fff1f2")
        self.canvas.delete("all")
        width = max(1, self.canvas.winfo_width())
        height = max(1, self.canvas.winfo_height())
        self.canvas.create_text(
            width / 2,
            height / 2,
            text=f"미리보기를 표시할 수 없습니다\n{message}",
            fill="#be123c",
            font=("Segoe UI", 10, "bold"),
            justify="center",
        )

    def draw(self, preview_plan: PreviewPlan, sample_times: list[float]) -> None:
        self.canvas.configure(background="#e2e8f0")
        self.canvas.delete("all")
        canvas_width = self.canvas.winfo_width()
        canvas_height = self.canvas.winfo_height()
        if canvas_width <= 2 or canvas_height <= 2:
            return

        output_width, output_height = preview_plan.output_size
        available_width = max(1, canvas_width - 2 * PREVIEW_INSET)
        available_height = max(1, canvas_height - 2 * PREVIEW_INSET)
        scale = min(available_width / output_width, available_height / output_height)
        display_width = output_width * scale
        display_height = output_height * scale
        origin_x = (canvas_width - display_width) / 2
        origin_y = (canvas_height - display_height) / 2

        is_grid = preview_plan.grid_size != (1, 1)
        margin = GRID_MARGIN if is_grid else 0
        padding = GRID_PADDING if is_grid else 0
        cell_width, cell_height = preview_plan.cell_size
        columns, rows = preview_plan.grid_size

        self.canvas.create_rectangle(
            origin_x,
            origin_y,
            origin_x + display_width,
            origin_y + display_height,
            fill="#eeeeee",
            outline="#cbd5e1",
            width=1,
        )
        for index, sample_time in enumerate(sample_times):
            column = index % columns
            row = index // columns
            cell_x = origin_x + (margin + column * (cell_width + padding)) * scale
            cell_y = origin_y + (margin + row * (cell_height + padding)) * scale
            self._draw_cell(
                cell_x,
                cell_y,
                cell_x + cell_width * scale,
                cell_y + cell_height * scale,
                index,
                sample_time,
            )

    def _draw_cell(
        self,
        x0: float,
        y0: float,
        x1: float,
        y1: float,
        index: int,
        sample_time: float,
    ) -> None:
        base_color, accent_color = PREVIEW_SAMPLE_COLORS[index % len(PREVIEW_SAMPLE_COLORS)]
        cell_width = max(1.0, x1 - x0)
        cell_height = max(1.0, y1 - y0)
        self.canvas.create_rectangle(
            x0,
            y0,
            x1,
            y1,
            fill=base_color,
            outline="#ffffff",
            width=1,
        )
        self.canvas.create_rectangle(
            x0,
            y0,
            x1,
            y0 + cell_height * 0.28,
            fill=accent_color,
            outline="",
        )
        self.canvas.create_oval(
            x0 + cell_width * 0.08,
            y0 + cell_height * 0.45,
            x0 + cell_width * 0.38,
            y0 + cell_height * 0.78,
            fill=accent_color,
            outline="",
        )
        font_size = max(7, min(13, int(min(cell_width, cell_height) / 9)))
        self.canvas.create_text(
            x0 + cell_width / 2,
            y0 + cell_height * 0.47,
            text=f"Sample {index + 1:02d}",
            fill="#ffffff",
            font=("Segoe UI", font_size, "bold"),
        )
        self.canvas.create_text(
            x0 + cell_width / 2,
            y0 + cell_height * 0.70,
            text=f"t={format_time(sample_time)}",
            fill="#f8fafc",
            font=("Segoe UI", max(7, font_size - 1)),
        )
