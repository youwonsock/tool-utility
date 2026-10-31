"""Model-free native runtime and stdio MCP regression checks; no user media/settings."""
from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
import threading
import time
import traceback

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'src'))
sys.dont_write_bytecode = True


def cancellation_server(workspace: Path):
    # Test-process adapter: occupy the single worker until cancel_job releases it.
    # The production MCP protocol and cancellation implementation remain unchanged.
    from video_tools.core.service import VideoService
    from video_tools.core.backend import OperationCancelled
    import video_tools.mcp.server as server_module

    class GatedService(VideoService):
        def __init__(self, ffmpeg=None):
            super().__init__(ffmpeg, workers=1)
            released, started = threading.Event(), threading.Event()

            def gate(cancel, _progress):
                started.set()
                deadline = time.monotonic() + 30
                while not released.wait(.05):
                    if cancel.is_set():
                        raise OperationCancelled()
                    if time.monotonic() >= deadline:
                        raise TimeoutError('Cancellation fixture was not released')
                return {}

            self.jobs.submit('fixture_gate', gate)
            if not started.wait(5):
                raise TimeoutError('Cancellation fixture did not start')
            original_cancel = self.jobs.cancel

            def cancel_job(job_id):
                result = original_cancel(job_id)
                released.set()
                return result

            self.jobs.cancel = cancel_job

    server_module.VideoService = GatedService
    server_module.create_server(workspace).run(transport='stdio')


def decoded_rgb(ffmpeg: str, path: Path) -> tuple[tuple[int, int], str]:
    """Decode an image with the checked FFmpeg; return its size and RGB24 hash."""
    from video_tools.core.backend import probe_image
    size = probe_image(ffmpeg, path)
    result = subprocess.run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', str(path),
                             '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
                            capture_output=True, timeout=30)
    if result.returncode or len(result.stdout) != size[0] * size[1] * 3:
        raise AssertionError(f'Image decode failed: {path.name}: {result.stderr[-500:]!r}')
    return size, hashlib.sha256(result.stdout).hexdigest()


def content(result):
    if result.isError:
        raise AssertionError(str(result.content))
    return result.structuredContent or json.loads(next(c.text for c in result.content if c.type == 'text'))


async def verify(report: dict, workspace: Path, ffmpeg: str):
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
    from video_tools.runtime import require_runtime
    require_runtime()
    source = workspace / 'source.mp4'
    command = [ffmpeg, '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
               'testsrc2=size=96x64:rate=10:duration=2', '-f', 'lavfi', '-i',
               'sine=frequency=440:sample_rate=44100', '-t', '2', '-c:v', 'libx264',
               '-pix_fmt', 'yuv420p', '-c:a', 'aac', str(source)]
    result = subprocess.run(command, capture_output=True, text=True, timeout=30)
    report['fixture_stderr'] = result.stderr
    if result.returncode:
        raise AssertionError(f'FFmpeg fixture exited {result.returncode}: {result.stderr}')
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    report['checks'].append('bundled_ffmpeg_fixture')
    environment = dict(os.environ)
    for key in ('PYTHONHOME', 'PYTHONPATH', 'TCL_LIBRARY', 'TK_LIBRARY', 'IMAGEIO_FFMPEG_EXE'):
        environment.pop(key, None)

    async def exercise(args, log_name, callback):
        params = StdioServerParameters(command=sys.executable, args=['-I', '-B', '-X', 'utf8', *args], env=environment)
        log_file = workspace / log_name
        try:
            with log_file.open('w', encoding='utf-8') as errors:
                async with stdio_client(params, errlog=errors) as (read, write):
                    async with ClientSession(read, write) as session:
                        await session.initialize()
                        await callback(session)
        finally:
            report[log_name] = log_file.read_text(encoding='utf-8', errors='replace') if log_file.exists() else ''

    async def normal(session):
        async def call(name, **kwargs):
            return content(await session.call_tool(name, kwargs))

        async def terminal(job, expected='completed'):
            async with asyncio.timeout(30):
                while True:
                    current = await call('get_job', job_id=job['job_id'])
                    if current['status'] in {'completed', 'failed', 'cancelled'}:
                        if current['status'] != expected:
                            raise AssertionError(current)
                        return current
                    await asyncio.sleep(.05)

        expected = {'server_info', 'list_media', 'inspect_video', 'start_frame_extraction', 'start_video_edit',
                    'get_job', 'list_jobs', 'cancel_job', 'read_image'}
        tools = await session.list_tools()
        assert {tool.name for tool in tools.tools} == expected
        assert (await call('server_info'))['transport'] == 'stdio'
        assert any(entry['path'] == 'source.mp4' for entry in (await call('list_media'))['entries'])
        info = await call('inspect_video', video_path='source.mp4')
        assert (info['display_width'], info['display_height']) == (96, 64) and info['has_audio']
        report['checks'].extend(['nine_mcp_tools', 'server_info', 'media_listing', 'video_inspection'])
        extracted = await terminal(await call('start_frame_extraction', video_path='source.mp4',
                                              output_directory='frames', interval=.5, width=64, height=36))
        assert extracted['result']['saved_count'] == 4
        hashes = {}
        for name in extracted['result']['files']:
            size, hashes[name] = decoded_rgb(ffmpeg, workspace / name)
            assert size == (64, 36)
        preview = await session.call_tool('read_image', {'image_path': extracted['result']['files'][0]})
        assert not preview.isError and any(c.type == 'image' and c.mimeType == 'image/jpeg'
                                           and base64.b64decode(c.data).startswith(b'\xff\xd8\xff')
                                           for c in preview.content)
        skipped = await terminal(await call('start_frame_extraction', video_path='source.mp4',
                                            output_directory='frames', interval=.5, width=64, height=36))
        assert skipped['result']['saved_count'] == 0 and skipped['result']['skipped_count'] == 4
        for name, before in hashes.items():
            assert decoded_rgb(ffmpeg, workspace / name)[1] == before
        grid = await terminal(await call('start_frame_extraction', video_path='source.mp4', output_directory='grid',
                                         interval=.5, grid_size=2, image_format='jpg', width=128, height=80))
        assert grid['result']['saved_count'] == 1
        grid_file = workspace / grid['result']['files'][0]
        assert decoded_rgb(ffmpeg, grid_file)[0] == (128, 80) and grid_file.read_bytes()[:3] == b'\xff\xd8\xff'
        report['checks'].extend(['four_png_frames', 'image_preview', 'existing_png_preserved', 'jpg_grid'])
        edited = await terminal(await call('start_video_edit', video_path='source.mp4', output_path='edited.mp4',
                                           start=0, end=1, width=64, height=36, mute=True))
        edit_info = edited['result']
        assert (edit_info['width'], edit_info['height']) == (64, 36)
        assert .8 <= edit_info['duration'] <= 1.2 and not edit_info['has_audio']
        edit_hash = hashlib.sha256((workspace / 'edited.mp4').read_bytes()).hexdigest()
        await terminal(await call('start_video_edit', video_path='source.mp4', output_path='edited.mp4'), 'failed')
        assert hashlib.sha256((workspace / 'edited.mp4').read_bytes()).hexdigest() == edit_hash
        await terminal(await call('start_video_edit', video_path='source.mp4', output_path='source.mp4'), 'failed')
        for name, args in [('inspect_video', {'video_path': '../outside.mp4'}),
                           ('start_frame_extraction', {'video_path': 'source.mp4', 'output_directory': '../outside'}),
                           ('start_video_edit', {'video_path': 'source.mp4', 'output_path': '../outside.mp4'})]:
            assert (await session.call_tool(name, args)).isError
        assert (await call('list_jobs'))['jobs']
        report['checks'].extend(['mp4_trim_resize_mute', 'existing_mp4_preserved', 'source_output_rejected', 'workspace_boundary', 'job_listing'])
        report['png_rgb_sha256'] = hashes

    async def cancellation(session):
        queued = content(await session.call_tool('start_frame_extraction', {
            'video_path': 'source.mp4', 'output_directory': 'cancelled', 'interval': .5}))
        assert queued['status'] == 'queued'
        assert content(await session.call_tool('cancel_job', {'job_id': queued['job_id']}))['accepted']
        async with asyncio.timeout(10):
            while True:
                current = content(await session.call_tool('get_job', {'job_id': queued['job_id']}))
                if current['status'] in {'completed', 'failed', 'cancelled'}:
                    assert current['status'] == 'cancelled', current
                    break
                await asyncio.sleep(.05)
        assert not (workspace / 'cancelled').exists()
        report['checks'].append('synchronized_queued_cancellation')

    await exercise([str(ROOT / 'launch.py'), 'mcp', '--workspace', str(workspace), '--ffmpeg', ffmpeg], 'mcp_stderr', normal)
    await exercise([str(Path(__file__).resolve()), '--cancel-server', '--workspace', str(workspace)], 'cancel_stderr', cancellation)
    assert hashlib.sha256(source.read_bytes()).hexdigest() == source_hash
    report['checks'].extend(['original_preserved', 'stdio_shutdown'])


def codec_matrix(report: dict, samples: Path, workspace: Path, ffmpeg: str):
    """Probe, extract and re-encode every sample file with the given FFmpeg."""
    from video_tools.core.backend import probe_video
    from video_tools.core.domain import SizePlan
    from video_tools.core.edit import EditRequest, edit_video
    from video_tools.core.media import ExtractionRequest, extract_images
    results = report.setdefault('codec_matrix', {})
    files = sorted(path for path in samples.iterdir()
                   if path.suffix.lower() in {'.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi'})
    if not files:
        raise AssertionError(f'No sample videos in {samples}')
    for path in files:
        info = probe_video(ffmpeg, path)
        end = min(info.duration, 1.0)
        frames = extract_images(ExtractionRequest(ffmpeg, path, workspace / path.stem, 'frame', 'png', 0, end, end / 2,
                                                  False, False, (1, 1), SizePlan(None, None, None)))
        edited = edit_video(EditRequest(ffmpeg, path, workspace / f'{path.stem}.mp4', 0, end))
        assert frames.count >= 1 and edited['has_audio'] == info.has_audio, path.name
        results[path.name] = {'codec': info.video_codec, 'size': list(info.display_size), 'rotation': info.rotation,
                              'audio': info.has_audio, 'frames': frames.count, 'edited_size': [edited['width'], edited['height']]}
    report['checks'].append('codec_matrix')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', type=Path, help='JSON diagnostic report outside the product folder')
    parser.add_argument('--codec-matrix', type=Path, help='Folder of sample videos to probe, extract and re-encode')
    parser.add_argument('--ffmpeg', type=Path, help='FFmpeg to check instead of the bundled one, e.g. a new build_ffmpeg.py output')
    parser.add_argument('--cancel-server', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--workspace', type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.cancel_server:
        cancellation_server(args.workspace)
        return 0
    if args.report and args.report.resolve().is_relative_to(ROOT):
        parser.error('--report must be outside the product folder')
    report = {'platform': platform.platform(), 'python': sys.version, 'checks': [], 'status': 'running'}
    started = time.monotonic()
    try:
        from video_tools.runtime import bundled_ffmpeg
        ffmpeg = str((args.ffmpeg or bundled_ffmpeg()).resolve())
        with tempfile.TemporaryDirectory(prefix='video smoke 한글 ') as temporary:
            asyncio.run(verify(report, Path(temporary), ffmpeg))
            if args.codec_matrix:
                codec_matrix(report, args.codec_matrix, Path(temporary) / 'codec-matrix', ffmpeg)
        report['status'] = 'passed'
    except Exception:
        report['status'] = 'failed'
        report['error'] = traceback.format_exc()
    report['elapsed_seconds'] = round(time.monotonic() - started, 3)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
