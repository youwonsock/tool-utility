"""Publish finished output files without losing existing ones."""

from __future__ import annotations

import os
from pathlib import Path
import shutil


def publish_file(staged: Path, destination: Path, overwrite: bool) -> bool:
    """Publish a completed file. Exclusive creation preserves existing outputs."""
    if overwrite:
        os.replace(staged, destination)
        return True
    try:
        os.link(staged, destination)
        return True
    except FileExistsError:
        return False
    except OSError:
        # Some Windows/network filesystems do not support hard links.
        try:
            output = destination.open("xb")
        except FileExistsError:
            return False
        try:
            with output, staged.open("rb") as source:
                shutil.copyfileobj(source, output)
        except BaseException:
            destination.unlink(missing_ok=True)
            raise
        return True
