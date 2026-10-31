import ast
import unittest
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1] / "src" / "video_tools"
# Operations go through VideoService; interfaces only need these types.
ALLOWED_FROM_CORE = {"video_tools.core.process": {"OperationCancelled"}, "video_tools.core.probe": {"VideoInfo"},
                     "video_tools.core.files": set()}


def imported_modules(path: Path) -> set[str]:
    modules = set()
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Import):
            modules.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            modules.add(node.module)
    return modules


class LayerTest(unittest.TestCase):
    def assert_no_imports(self, folder: Path, forbidden: tuple[str, ...]):
        for path in folder.rglob("*.py"):
            for module in imported_modules(path):
                self.assertFalse(module.startswith(forbidden), f"{path.name} imports {module}")

    def test_core_depends_on_no_interface(self):
        self.assert_no_imports(SOURCE / "core", ("video_tools.gui", "video_tools.mcp", "tkinter", "mcp"))

    def test_interfaces_stay_apart(self):
        self.assert_no_imports(SOURCE / "gui", ("video_tools.mcp", "mcp"))
        self.assert_no_imports(SOURCE / "mcp", ("video_tools.gui", "tkinter"))

    def test_gui_reaches_the_core_through_the_service_for_operations(self):
        for folder in ("gui", "mcp"):
            for path in (SOURCE / folder).rglob("*.py"):
                for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
                    if isinstance(node, ast.ImportFrom) and node.module in ALLOWED_FROM_CORE:
                        names = {alias.name for alias in node.names}
                        self.assertLessEqual(names, ALLOWED_FROM_CORE[node.module], path.name)

    def test_options_stay_free_of_tk(self):
        self.assertFalse(any(module.startswith("tkinter") for module in imported_modules(SOURCE / "gui" / "options.py")))
