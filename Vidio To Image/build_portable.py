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

def copy_runtime_licenses(legal, python_stdlib, python_prefix, tk_libraries, tcl_version,
                          fallback_root=ROOT / 'licenses'):
    """Preserve installed notices, including the Windows runtime layout."""
    sources = {
        'Python-LICENSE.txt': [python_stdlib / 'LICENSE.txt', python_prefix / 'LICENSE.txt'],
    }
    for name, location in tk_libraries.items():
        sources[name + '-license.terms'] = [parent / 'license.terms' for parent in
                                           (location, location.parent, location.parent.parent)]
    # CPython's Windows Tcl install omits its upstream notice. Keep the exact
    # release's notice in the source tree so packaging never needs a download.
    sources['tcl_library-license.terms'].append(fallback_root / f'tcl-{tcl_version}-license.terms')
    for name, candidates in sources.items():
        source = next((p for p in candidates if p.is_file() and p.stat().st_size), None)
        if source is None:
            raise RuntimeError(f'Required runtime notice is missing: {name}; checked {candidates}')
        shutil.copy2(source, legal / name)

def run(args, **kwargs):
    return subprocess.run(args, check=True, cwd=ROOT, **kwargs)

def source_metadata():
    revision = run(['git', 'rev-parse', 'HEAD'], capture_output=True, text=True, encoding='utf-8').stdout.strip()
    changes = run(['git', 'status', '--porcelain', '--untracked-files=all', '--', '.'],
                  capture_output=True, text=True, encoding='utf-8').stdout
    return {'source_commit': revision, 'source_dirty': bool(changes)}

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
    tcl_version = app.tk.call('info', 'patchlevel')
    tk_libraries = {name: Path(str(app.tk.call('set', name))) for name in ('tcl_library', 'tk_library')}
    app.destroy()
    if metadata.version('pyinstaller') != '6.22.3':
        raise SystemExit('Install the locked release dependencies (PyInstaller 6.22.3).')
    vendor = Path(imageio_ffmpeg.get_ffmpeg_exe())
    media = ROOT / 'build/media'
    media.mkdir(parents=True, exist_ok=True)
    target = media / ('ffmpeg.exe' if sys.platform == 'win32' else 'ffmpeg')
    shutil.copy2(vendor, target)
    version = run([str(target), '-version'], capture_output=True, text=True, encoding="utf-8").stdout
    encoders = run([str(target), '-hide_banner', '-encoders'], capture_output=True, text=True, encoding="utf-8").stdout
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
    copy_runtime_licenses(legal, Path(sysconfig.get_path('stdlib')), Path(sys.base_prefix),
                          tk_libraries, tcl_version)
    (legal / 'FFmpeg-license.txt').write_text(run([str(target), '-L'], capture_output=True, text=True, encoding="utf-8").stdout, encoding='utf-8')
    (legal / 'FFmpeg-provenance.txt').write_text(
        'Provider: imageio-ffmpeg 0.6.0 platform wheel\n'
        'Provider source/build information: https://github.com/imageio/imageio-ffmpeg/tree/v0.6.0\n'
        'FFmpeg source releases: https://ffmpeg.org/releases/\n'
        'Binary configuration and exact upstream version:\n' + version, encoding='utf-8')
    manifest = {'python': platform.python_version(), 'tcl': tcl_version, 'tk': tk_version, 'platform': platform.system(),
                'architecture': platform.machine(), 'dependencies': packages,
                'ffmpeg_original_sha256': hashlib.sha256(vendor.read_bytes()).hexdigest(),
                'ffmpeg_version': version, 'required_encoders': ['libx264', 'aac'],
                **source_metadata()}
    (legal / 'build-manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')

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
