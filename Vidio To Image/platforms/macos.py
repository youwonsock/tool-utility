"""macOS presentation and user-data conventions."""
from .posix import process_options, stop_process, wheel_units, bind_precise_scroll

executable_suffix = ""
font_family = None  # Resolve TkDefaultFont after the GUI exists.
theme = "clam"

def settings_path(home, environ):
    return home / "Library/Application Support/VideoToImage/settings.json"

def install_quit_handler(root, callback):
    root.createcommand('tk::mac::Quit', callback)

