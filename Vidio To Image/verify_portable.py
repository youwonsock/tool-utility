"""Verify the relocated native product without host Python/media executables."""
import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import asyncio
from pathlib import Path

ROOT = Path(__file__).resolve().parent

async def compare_gui_mcp(executable, ffmpeg, workspace, environment, gui):
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
    from media_test_support import make_video
    from PIL import Image
    workspace.mkdir()
    make_video(workspace / 'input.mp4', str(ffmpeg))
    async with stdio_client(StdioServerParameters(command=str(executable), args=['--workspace', str(workspace)], env=environment)) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            async def call(name, args):
                response = await session.call_tool(name, args)
                if response.isError: raise RuntimeError(str(response.content))
                return response.structuredContent
            async def finish(job):
                for _ in range(300):
                    state = await call('get_job', {'job_id': job['job_id']})
                    if state['status'] == 'completed': return state['result']
                    if state['status'] in {'failed', 'cancelled'}: raise RuntimeError(str(state))
                    await asyncio.sleep(.05)
                raise TimeoutError('MCP parity job did not finish')
            frames = await finish(await call('start_frame_extraction', {'video_path': 'input.mp4', 'output_directory': 'frames'}))
            pixels = []
            for path in frames['files']:
                with Image.open(workspace / path) as image:
                    pixels.append(list(image.convert('RGB').getpixel((32, 18))))
            if pixels != gui['frame_pixels']: raise RuntimeError(f'GUI/MCP pixel mismatch: {pixels}')
            edited = await finish(await call('start_video_edit', {'video_path': 'input.mp4', 'output_path': 'edited.mp4',
                'start': 1, 'end': 3, 'rotation': 90, 'speed': 2, 'mute': True, 'width': 128, 'height': 72}))
            info = await call('inspect_video', {'video_path': 'edited.mp4'})
            for key in ('width', 'height', 'has_audio'):
                if edited[key] != gui['editing'][key]: raise RuntimeError(f'GUI/MCP {key} mismatch')
            if abs(edited['duration'] - gui['editing']['duration']) > .1 or abs(info['fps'] - gui['edit_fps']) > .01:
                raise RuntimeError('GUI/MCP timing mismatch')
            return {'identical_frame_pixels': True, 'matching_edit_geometry_timing_audio': True}

def main():
    evidence = {'platform': platform.system(), 'architecture': platform.machine(), 'status': 'running'}
    output = ROOT / 'test-output'
    output.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='영상 배포 verification ') as directory:
        relocated = Path(directory) / '한글 경로 with spaces'
        if sys.platform == 'darwin':
            product = relocated / 'VideoToImage.app'
            shutil.copytree(ROOT / 'dist/VideoToImage.app', product, symlinks=True)
            binaries = product / 'Contents/MacOS'
            media = product / 'Contents/Frameworks/media/ffmpeg'
            legal = product / 'Contents/Resources/licenses'
            isolated_path = '/usr/bin:/bin:/usr/sbin:/sbin'
            subprocess.run(['codesign', '--verify', '--deep', '--strict', str(product)], check=True)
        else:
            product = relocated / 'VideoToImage'
            shutil.copytree(ROOT / 'dist/VideoToImage', product)
            binaries = product
            media = product / '_internal/media/ffmpeg.exe'
            legal = product / '_internal/licenses'
            isolated_path = str(Path(os.environ['SystemRoot']) / 'System32')
        suffix = '.exe' if sys.platform == 'win32' else ''
        environment = {**os.environ, 'PATH': isolated_path, 'PYTHONPATH': '', 'PYTHONHOME': ''}
        try:
            required_notices = ['Python-LICENSE.txt', 'tcl_library-license.terms',
                                'tk_library-license.terms', 'FFmpeg-license.txt', 'FFmpeg-provenance.txt']
            for name in required_notices:
                path = legal / name
                if not path.is_file() or not path.stat().st_size:
                    raise RuntimeError(f'Packaged runtime notice is missing: {name}')
            evidence['license_inventory'] = required_notices
            report = output / 'gui-portable.json'
            gui = subprocess.run([str(binaries / ('VideoToImage' + suffix)), '--self-test-report', str(report)],
                                 env=environment, cwd=relocated, capture_output=True, text=True, encoding="utf-8", timeout=120)
            if gui.returncode:
                raise RuntimeError(report.read_text(encoding="utf-8") if report.exists() else gui.stderr)
            evidence['gui'] = json.loads(report.read_text(encoding="utf-8"))
            if evidence['gui']['status'] != 'passed': raise RuntimeError(str(evidence['gui']))
            tests_env = {**environment, 'VIDEO_TOOLS_TEST_MCP': str(binaries / ('video-tools-mcp' + suffix)),
                         'VIDEO_TOOLS_TEST_FFMPEG': str(media), 'VIDEO_TOOLS_FFMPEG_ONLY': '1',
                         'VIDEO_TOOLS_ISOLATED_PATH': isolated_path}
            tests = subprocess.run([sys.executable, '-m', 'unittest', 'test_video_integration', 'test_video_mcp',
                                    'test_video_portable.PortableTests.test_mcp_shutdown_preserves_process_stdio', '-v'],
                                   env=tests_env, cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=180)
            evidence['integration'] = {'returncode': tests.returncode, 'stdout': tests.stdout, 'stderr': tests.stderr}
            if tests.returncode: raise RuntimeError(tests.stderr)
            evidence['gui_mcp_parity'] = asyncio.run(compare_gui_mcp(binaries / ('video-tools-mcp' + suffix),
                 media, relocated / 'parity workspace', environment, evidence['gui']))
            # Check actual binary storage, ignoring bundle resource symlinks.
            copies = [p for p in product.rglob('*') if p.name in ('ffmpeg', 'ffmpeg.exe') and p.is_file() and not p.is_symlink()]
            if len(copies) != 1: raise RuntimeError(f'Expected one shared FFmpeg binary, found {copies}')
            evidence.update(status='passed', shared_ffmpeg_copies=len(copies),
                            external_path=isolated_path, relocated_path_tested=True)
        except Exception as exc:
            evidence.update(status='failed', error=str(exc))
        finally:
            (output / 'portable-verification.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding='utf-8')
    print(evidence['status'])
    return 0 if evidence['status'] == 'passed' else 1

if __name__ == '__main__':
    raise SystemExit(main())
