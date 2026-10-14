"""Runtime notice regressions for installed Windows and macOS layouts."""
import tempfile
import unittest
from pathlib import Path

from build_portable import copy_runtime_licenses


class RuntimeNoticeTests(unittest.TestCase):
    def test_windows_prefix_license_and_exact_tcl_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            legal = root / 'legal'
            legal.mkdir()
            prefix = root / 'Python'
            stdlib = prefix / 'Lib'
            tcl = prefix / 'tcl/tcl8.6'
            tk = prefix / 'tcl/tk8.6'
            for p in (stdlib, tcl, tk):
                p.mkdir(parents=True, exist_ok=True)
            (prefix / 'LICENSE.txt').write_text('Python installed notice')
            (tk / 'license.terms').write_text('Tk installed notice')
            copy_runtime_licenses(legal, stdlib, prefix,
                                  {'tcl_library': tcl, 'tk_library': tk}, '8.6.15')
            self.assertEqual((legal / 'Python-LICENSE.txt').read_text(), 'Python installed notice')
            self.assertEqual((legal / 'tk_library-license.terms').read_text(), 'Tk installed notice')
            self.assertEqual((legal / 'tcl_library-license.terms').read_bytes(),
                             (Path(__file__).parent / 'licenses/tcl-8.6.15-license.terms').read_bytes())

    def test_framework_notices_take_precedence_over_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            legal = root / 'legal'
            legal.mkdir()
            (root / 'LICENSE.txt').write_text('Python stdlib notice')
            libraries = {}
            for name in ('tcl_library', 'tk_library'):
                resources = root / name / 'Resources'
                scripts = resources / 'Scripts'
                scripts.mkdir(parents=True)
                (resources / 'license.terms').write_text(name + ' installed notice')
                libraries[name] = scripts
            copy_runtime_licenses(legal, root, root / 'unused', libraries, '8.6.15')
            for name in libraries:
                self.assertEqual((legal / (name + '-license.terms')).read_text(), name + ' installed notice')

    def test_missing_notice_fails_even_with_stale_build_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            legal = root / 'legal'
            legal.mkdir()
            (root / 'LICENSE.txt').write_text('Python installed notice')
            (legal / 'tcl_library-license.terms').write_text('Stale build notice')
            with self.assertRaisesRegex(RuntimeError, 'tcl_library-license.terms'):
                copy_runtime_licenses(legal, root, root,
                                      {'tcl_library': root / 'missing-tcl', 'tk_library': root / 'missing-tk'},
                                      '0.0', fallback_root=root / 'missing-fallback')
