"""Deterministic GUI acceptance check; only writes to an explicit report/temp directory."""
import json
import time
import tempfile
import subprocess
from pathlib import Path
from unittest.mock import patch
from dataclasses import replace

def run_gui_test(report: Path):
    from video_to_image import VideoToImageApp
    from video_to_image_backend import probe_video
    from video_to_image_media import ProbeCompleted
    from media_test_support import image_signature, make_video
    app = None
    evidence = {}
    try:
        with tempfile.TemporaryDirectory(prefix='영상 GUI check ') as temporary:
            root = Path(temporary)
            app = VideoToImageApp(root / 'settings.json')
            callback_errors = []
            app.report_callback_exception = lambda kind, value, tb: callback_errors.append(str(value))
            app.update()
            evidence['layout_sizes'] = []
            for width, height in ((760, 760), (1100, 900)):
                app.geometry(f'{width}x{height}')
                app.update()
                assert app.start_button.winfo_rootx() + app.start_button.winfo_width() <= app.winfo_rootx() + app.winfo_width()
                for widget in app.editor.widgets:
                    assert widget.winfo_x() >= 0
                    assert widget.winfo_x() + widget.winfo_width() <= widget.master.winfo_width(), str(widget)
                evidence['layout_sizes'].append([width, height])
            app.withdraw()
            evidence['window_system'] = app.tk.call('tk', 'windowingsystem')
            evidence['font'] = app.font_family
            source = root / '한글 input [1].mp4'
            make_video(source, app.service.ffmpeg)
            info = app.service.inspect(source)
            app.output_var.set(str(root / 'captures'))
            with patch('video_to_image.filedialog.askopenfilename', return_value=str(source)):
                app._choose_video()
            from video_to_image_editor import show_mcp_configuration
            import tkinter as tk
            from tkinter import ttk
            show_mcp_configuration(app)
            dialog = next(w for w in app.winfo_children() if isinstance(w, tk.Toplevel))
            body = dialog.winfo_children()[0]
            workspace_entry = next(w for w in body.winfo_children() if isinstance(w, ttk.Entry) and int(w.grid_info()['row']) == 1)
            dialog.setvar(workspace_entry.cget('textvariable'), str(root))
            generate = next(w for w in body.winfo_children() if isinstance(w, ttk.Frame)).winfo_children()[0]
            generate.invoke()
            config_text = next(w for w in body.winfo_children() if isinstance(w, tk.Text))
            entry = json.loads(config_text.get('1.0', 'end'))['mcpServers']['video-tools']
            assert entry['args'][-2:] == ['--workspace', str(root.resolve())], entry
            assert Path(entry['command']).is_file(), entry
            evidence['gui_mcp_configuration'] = True
            dialog.destroy()
            def finish():
                deadline = time.monotonic() + 30
                while app.current_job and time.monotonic() < deadline:
                    app.update()
                    time.sleep(.02)
                assert not app.current_job, 'GUI job did not terminate'
                job = app.service.jobs.list()[0]
                assert job['status'] == 'completed', job
                assert str(app.start_button.cget('state')) == 'normal'
                assert str(app.cancel_button.cget('state')) == 'disabled'
                return job['result']
            with patch('video_to_image.messagebox.showinfo'), patch('video_to_image.messagebox.showerror') as errors:
                deadline = time.monotonic() + 5
                while app.video_info is None and time.monotonic() < deadline:
                    app.update(); time.sleep(.02)
                assert app.video_info is not None, 'GUI metadata probe did not arrive'
                app.output_mode_var.set('개별 이미지 저장')
                app.size_mode_var.set('격자 셀 이미지 크기')
                app.size_preset_var.set('원본')
                app.interval_var.set('1')
                app._start()
                result = finish()
                assert result['saved_count'] == 4, result
                evidence['extraction'] = result['saved_count']
                evidence['frame_signatures'] = [image_signature(Path(path)) for path in result['files']]
                app.format_var.set('JPG')
                app.output_mode_var.set('격자 합치기')
                app.grid_size_var.set('2 × 2')
                app.size_mode_var.set('최종 이미지 해상도')
                app.size_preset_var.set('사용자 지정')
                app.size_width_var.set('146'); app.size_height_var.set('90')
                app.prefix_var.set('grid[1]%')
                app._start()
                result = finish()
                assert result['saved_count'] == 1, result
                from PIL import Image
                with Image.open(result['files'][0]) as image:
                    assert image.size == (146, 90), image.size
                evidence['jpg_grid'] = True
                app.notebook.select(1); app.update()
                assert app.mode_var.get() == 'edit'
                f = app.editor.fields
                f['output'].set(str(root / 'edited.mp4'))
                f['rotation'].set('90'); f['speed'].set('2'); f['mute'].set(True)
                f['resize_enabled'].set(True); f['width'].set('128'); f['height'].set('72')
                app.start_var.set('1'); app.end_var.set('3')
                app._start()
                result = finish()
                assert (result['width'], result['height'], result['has_audio']) == (128, 72, False), result
                assert abs(result['duration'] - 1) < .15, result
                assert not errors.called, errors.call_args
                assert not callback_errors, callback_errors
                evidence['editing'] = result
                evidence['edit_fps'] = app.service.inspect(Path(result['output_path'])).fps
                f['output'].set(str(root / 'crop.mp4'))
                f['crop_enabled'].set(True)
                f['crop_x'].set('1'); f['crop_y'].set('1')
                f['crop_width'].set('30'); f['crop_height'].set('20')
                f['rotation'].set('0'); f['speed'].set('1'); f['resize_enabled'].set(False)
                f['flip_horizontal'].set(True); f['flip_vertical'].set(True); f['crf'].set('18')
                app._start()
                crop_result = finish()
                assert (crop_result['width'], crop_result['height']) == (30, 20), crop_result
                evidence['crop_flip_crf'] = True
                f['speed'].set('2')
                app.notebook.select(0); app.update()
                app.output_mode_var.set('개별 이미지 저장')
                app.size_width_var.set('1280'); app.size_height_var.set('720')
                app.prefix_var.set('cancel'); app.interval_var.set('0.005')
                app._start()
                app._cancel()
                deadline = time.monotonic() + 10
                while app.current_job and time.monotonic() < deadline:
                    app.update(); time.sleep(.02)
                assert not app.current_job, 'GUI cancellation did not finish'
                assert app.service.jobs.list()[0]['status'] == 'cancelled'
                assert not list((root / 'captures').glob('cancel_*.jpg'))
                evidence['gui_cancel'] = True
                app._save_settings()
                assert (root / 'settings.json').is_file()
                evidence['settings'] = True
            app._close(); app = None
            restored = VideoToImageApp(root / 'settings.json')
            try:
                restored.withdraw(); restored.update()
                assert restored.editor.fields['speed'].get() == '2'
                assert restored.editor.fields['mute'].get()
                evidence['settings_restored'] = True
            finally:
                restored._close()
        evidence['status'] = 'passed'
        code = 0
    except Exception as exc:
        import traceback
        evidence.update(status='failed', error=str(exc), traceback=traceback.format_exc())
        code = 1
    finally:
        if app:
            app._close()
        report.parent.mkdir(parents=True, exist_ok=True)
        report.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding='utf-8')
    return code
