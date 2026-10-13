"""OS adapters. No GUI or MCP imports are permitted here."""
import sys

if sys.platform == "win32":
    from . import windows as current
elif sys.platform == "darwin":
    from . import macos as current
else:
    from . import posix as current

