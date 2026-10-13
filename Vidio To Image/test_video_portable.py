"""Portable architecture, state and real GUI acceptance regressions."""
import ast
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from platforms import windows, macos
from video_to_image_settings import AppSettings, EditingSettings, load_settings, save_settings
from video_to_image_runtime import configuration
from video_to_image_jobs import JobManager

class PortableTests(unittest.TestCase):
    def test_core_imports_no_gui_or_sdk(self):
        result = subprocess.run([sys.executable, '-c',
            'import video_to_image_service, sys; assert not any(n == "tkinter" or n.startswith("mcp") for n in sys.modules)'],
            capture_output=True, text=True, encoding="utf-8", timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_platform_settings_and_mouse_wheel(self):
        home = Path('/user')
        self.assertEqual(windows.settings_path(home, {'APPDATA': '/roaming'}), Path('/roaming/VideoToImage/settings.json'))
        self.assertEqual(macos.settings_path(home, {}), home / 'Library/Application Support/VideoToImage/settings.json')
        self.assertEqual([windows.wheel_units(v) for v in [120, -120, 0]], [-1, 1, 0])
        self.assertEqual([macos.wheel_units(v) for v in [1, -1, 0]], [-1, 1, 0])

    def test_editing_settings_round_trip_and_legacy_mac_migration(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            legacy = home / 'AppData/Roaming/VideoToImage/settings.json'
            target = home / 'Library/Application Support/VideoToImage/settings.json'
            settings = AppSettings(editing=EditingSettings(speed='2', crop_enabled=True, rotation='90', mute=True))
            self.assertTrue(save_settings(settings, legacy))
            with patch('video_to_image_settings.sys.platform', 'darwin'), \
                 patch('video_to_image_settings.Path.home', return_value=home), \
                 patch('video_to_image_settings.default_settings_path', return_value=target):
                self.assertEqual(load_settings(), settings)
            self.assertTrue(legacy.is_file())
            self.assertEqual(load_settings(target), settings)

    def test_portable_configuration_uses_binary_and_rejects_temporary_location(self):
        with tempfile.TemporaryDirectory(prefix='설정 경로 ') as directory:
            binary = Path(directory) / 'video-tools-mcp'
            binary.write_bytes(b'fixture')
            entry = configuration(Path(directory), binary)['mcpServers']['video-tools']
            self.assertEqual(entry['command'], str(binary))
            self.assertEqual(entry['args'], ['--workspace', str(Path(directory).resolve())])
            with self.assertRaises(ValueError):
                configuration(Path(directory), Path(directory) / 'AppTranslocation/video-tools-mcp')

    def test_job_results_are_snapshots(self):
        manager = JobManager(workers=1)
        try:
            job = manager.submit('fixture', lambda cancel, progress: {'files': ['original']})
            deadline = time.monotonic() + 5
            while manager.get(job['job_id'])['status'] not in {'completed', 'failed'} and time.monotonic() < deadline:
                time.sleep(.01)
            view = manager.get(job['job_id'])
            view['result']['files'].append('mutation')
            self.assertEqual(manager.get(job['job_id'])['result']['files'], ['original'])
        finally:
            manager.close()

    def test_frozen_ffmpeg_missing_does_not_fall_back_to_host(self):
        from video_to_image_backend import find_ffmpeg
        with patch('video_to_image_backend.bundled', return_value=True), \
             patch('video_to_image_backend.bundled_ffmpeg', return_value=Path('/missing/media/ffmpeg')), \
             patch('video_to_image_backend.shutil.which') as which:
            with self.assertRaises(RuntimeError): find_ffmpeg()
            which.assert_not_called()

    def test_mcp_shutdown_preserves_process_stdio(self):
        with tempfile.TemporaryDirectory() as workspace:
            message = {'jsonrpc':'2.0', 'id':1, 'method':'initialize', 'params':{
                'protocolVersion':'2025-11-25', 'capabilities':{}, 'clientInfo':{'name':'shutdown-test', 'version':'1'}}}
            executable = os.environ.get('VIDEO_TOOLS_TEST_MCP')
            command = [executable] if executable else [sys.executable, 'video_to_image_mcp.py']
            result = subprocess.run(command + ['--workspace', workspace], input=json.dumps(message)+'\n',
                                    capture_output=True, text=True, encoding="utf-8", timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn('Traceback', result.stderr)
            self.assertEqual(json.loads(result.stdout.splitlines()[0])['id'], 1)

    @unittest.skipUnless(os.environ.get('VIDEO_TOOLS_GUI_TESTS'), 'GUI tests require a native window server or Xvfb')
    def test_gui_acceptance(self):
        from portable_selftest import run_gui_test
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory) / 'gui.json'
            self.assertEqual(run_gui_test(report), 0, report.read_text(encoding="utf-8"))
            self.assertEqual(json.loads(report.read_text(encoding="utf-8"))['status'], 'passed')

    @unittest.skipUnless(os.environ.get('VIDEO_TOOLS_GUI_TESTS'), 'GUI tests require a native window server or Xvfb')
    def test_gui_invalid_edit_and_disabled_tab_callbacks(self):
        from video_to_image import VideoToImageApp
        from media_test_support import make_video
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = VideoToImageApp(root / 'settings.json')
            callbacks = []
            app.report_callback_exception = lambda kind, value, tb: callbacks.append(str(value))
            try:
                app.withdraw(); app.update()
                app._set_controls('disabled'); app.update()
                app._set_controls('normal'); app.update()
                self.assertEqual(callbacks, [])
                app.deiconify(); app.update()
                app.scroll_canvas.yview_moveto(0)
                before = app.scroll_canvas.yview()[0]
                app.output_mode_combo.event_generate('<MouseWheel>', delta=-120)
                app.update()
                self.assertGreater(app.scroll_canvas.yview()[0], before)
                self.assertEqual(app.output_mode_var.get(), '격자 합치기')
                if app.tk.call('info', 'commands', 'tk::PreciseScrollDeltas'):
                    app.scroll_canvas.yview_moveto(0)
                    app.output_mode_combo.event_generate('<TouchpadScroll>', delta=65516)
                    app.update()
                    self.assertGreater(app.scroll_canvas.yview()[0], 0)
                    self.assertEqual(app.output_mode_var.get(), '격자 합치기')
                source = root / 'input.mp4'
                make_video(source, app.service.ffmpeg)
                app.video_path = source
                app.video_info = app.service.inspect(source)
                app.start_var.set('0'); app.end_var.set('1')
                app.editor.fields['output'].set(str(root / 'out.mp4'))
                app.editor.fields['speed'].set('nan')
                with patch('video_to_image.messagebox.showerror') as error:
                    app._start_edit()
                self.assertTrue(error.called)
                self.assertIsNone(app.current_job)
                self.assertFalse((root / 'out.mp4').exists())
            finally:
                app._close()
