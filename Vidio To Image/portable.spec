# One runtime directory, two independent entrypoint archives/bootloaders.
from pathlib import Path
import sys
from PyInstaller.utils.hooks import collect_data_files, collect_submodules, copy_metadata

root = Path(SPECPATH)
shared_data = [(str(root / 'build/legal'), 'licenses')]
for package in ('mcp', 'jsonschema_specifications'):
    shared_data += collect_data_files(package)
for package in ('mcp', 'pydantic', 'pydantic-settings'):
    shared_data += copy_metadata(package)
media = [(str(root / 'build/media' / ('ffmpeg.exe' if sys.platform == 'win32' else 'ffmpeg')), 'media')]
options = dict(pathex=[str(root)], binaries=media, datas=shared_data,
               excludes=['imageio_ffmpeg', 'mcp.cli'],
               hiddenimports=collect_submodules('mcp', filter=lambda name: not name.startswith('mcp.cli')))
gui = Analysis([str(root / 'video_to_image.py')], **options)
server = Analysis([str(root / 'video_to_image_mcp.py')], **options)
gui_exe = EXE(PYZ(gui.pure), gui.scripts, [], exclude_binaries=True, name='VideoToImage',
              console=False, upx=False)
mcp_exe = EXE(PYZ(server.pure), server.scripts, [('u', None, 'OPTION')], exclude_binaries=True,
              name='video-tools-mcp', console=True, upx=False)
collection = COLLECT(gui_exe, mcp_exe, gui.binaries, server.binaries, gui.datas, server.datas,
                     strip=False, upx=False, name='VideoToImage')
if sys.platform == 'darwin':
    app = BUNDLE(collection, name='VideoToImage.app', bundle_identifier='com.youwonsock.videotoimage',
                 info_plist={'CFBundleExecutable': 'VideoToImage', 'NSHighResolutionCapable': True,
                             'LSBackgroundOnly': False, 'LSUIElement': False})
