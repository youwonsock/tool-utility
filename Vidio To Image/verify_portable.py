"""Verify the relocated native product without host Python/media executables."""
import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent

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
            isolated_path = '/usr/bin:/bin:/usr/sbin:/sbin'
            subprocess.run(['codesign', '--verify', '--deep', '--strict', str(product)], check=True)
        else:
            product = relocated / 'VideoToImage'
            shutil.copytree(ROOT / 'dist/VideoToImage', product)
            binaries = product
            media = product / '_internal/media/ffmpeg.exe'
            isolated_path = str(Path(os.environ['SystemRoot']) / 'System32')
        suffix = '.exe' if sys.platform == 'win32' else ''
        environment = {**os.environ, 'PATH': isolated_path, 'PYTHONPATH': '', 'PYTHONHOME': ''}
        try:
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
