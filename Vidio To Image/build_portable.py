"""Native portable release builder. Build-time dependencies never run in the product."""
import argparse
import hashlib
import importlib.metadata as metadata
import json
import platform
import shutil
import subprocess
import sys
import sysconfig
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent

def run(args, **kwargs):
    return subprocess.run(args, check=True, cwd=ROOT, **kwargs)

def prepare():
    if platform.system() not in {'Windows', 'Darwin'}:
        raise SystemExit('Portable release builds require Windows or macOS.')
    if sys.version_info[:3] != (3, 14, 6):
        raise SystemExit('Release builds use Python 3.14.6; source development supports Python 3.10+.')
    import tkinter as tk
    import imageio_ffmpeg
    app = tk.Tk()
    app.withdraw()
    app.update_idletasks()
    tk_version = app.tk.call('package', 'provide', 'Tk')
    app.destroy()
    if metadata.version('pyinstaller') != '6.22.3':
        raise SystemExit('Install the locked release dependencies (PyInstaller 6.22.3).')
    vendor = Path(imageio_ffmpeg.get_ffmpeg_exe())
    media = ROOT / 'build/media'
    media.mkdir(parents=True, exist_ok=True)
    target = media / ('ffmpeg.exe' if sys.platform == 'win32' else 'ffmpeg')
    shutil.copy2(vendor, target)
    version = run([str(target), '-version'], capture_output=True, text=True).stdout
    encoders = run([str(target), '-hide_banner', '-encoders'], capture_output=True, text=True).stdout
    if 'libx264' not in encoders or 'aac' not in encoders:
        raise SystemExit('Bundled FFmpeg requires libx264 and AAC encoders.')
    legal = ROOT / 'build/legal'
    legal.mkdir(parents=True, exist_ok=True)
    packages = {d.metadata['Name']: d.version for d in metadata.distributions() if d.metadata['Name'] != 'pip'}
    for distribution in metadata.distributions():
        for file in distribution.files or []:
            if any(x in str(file).lower() for x in ('license', 'copying', 'notice')):
                source = Path(distribution.locate_file(file))
                if source.is_file():
                    destination = legal / distribution.metadata['Name'] / str(file)
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(source, destination)
    python_license = Path(sysconfig.get_path('stdlib')) / 'LICENSE.txt'
    if python_license.is_file():
        shutil.copy2(python_license, legal / 'Python-LICENSE.txt')
    (legal / 'FFmpeg-license.txt').write_text(run([str(target), '-L'], capture_output=True, text=True).stdout)
    (legal / 'FFmpeg-provenance.txt').write_text(
        'Provider: imageio-ffmpeg 0.6.0 platform wheel\n'
        'Provider source/build information: https://github.com/imageio/imageio-ffmpeg/tree/v0.6.0\n'
        'FFmpeg source releases: https://ffmpeg.org/releases/\n'
        'Binary configuration and exact upstream version:\n' + version)
    manifest = {'python': platform.python_version(), 'tk': tk_version, 'platform': platform.system(),
                'architecture': platform.machine(), 'dependencies': packages,
                'ffmpeg_original_sha256': hashlib.sha256(vendor.read_bytes()).hexdigest(),
                'ffmpeg_version': version, 'required_encoders': ['libx264', 'aac'],
                'source_commit': run(['git', 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip()}
    (legal / 'build-manifest.json').write_text(json.dumps(manifest, indent=2))

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--package', action='store_true')
    args = parser.parse_args()
    prepare()
    run([sys.executable, '-m', 'PyInstaller', '--noconfirm', '--clean', '--log-level', 'WARN',
         '--distpath', str(ROOT / 'dist'), '--workpath', str(ROOT / 'build/pyinstaller'),
         str(ROOT / 'portable.spec')])
    if sys.platform == 'darwin':
        product = ROOT / 'dist/VideoToImage.app'
        run(['codesign', '--verify', '--deep', '--strict', str(product)])
        archive = ROOT / f'dist/VideoToImage-macos-{platform.machine()}.zip'
        if args.package:
            run(['ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', str(product), str(archive)])
    else:
        product = ROOT / 'dist/VideoToImage'
        archive = ROOT / 'dist/VideoToImage-win64.zip'
        if args.package:
            with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as output:
                for file in product.rglob('*'):
                    if file.is_file():
                        output.write(file, file.relative_to(product))
    if args.package:
        archive.with_suffix('.zip.sha256').write_text(hashlib.sha256(archive.read_bytes()).hexdigest() + '  ' + archive.name + '\n')
    print(product)

if __name__ == '__main__':
    main()
