"""Runtime notice regressions for installed Windows and macOS layouts."""
import tempfile
import unittest
import subprocess
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

from build_portable import copy_runtime_licenses, source_metadata


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


class SourceMetadataTests(unittest.TestCase):
    @contextmanager
    def repository(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            video = repo / 'video'
            video.mkdir()
            (video / 'source.py').write_text('original\n')
            (video / '.gitignore').write_text('build/\n')
            def git(*arguments):
                return subprocess.run(['git', '-C', str(repo), *arguments], check=True,
                                      capture_output=True, text=True, encoding='utf-8').stdout
            git('init', '-q', '-b', 'main')
            git('add', 'video')
            git('-c', 'commit.gpgsign=false', '-c', 'user.name=Test Fixture',
                '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture')
            with patch('build_portable.ROOT', video):
                yield repo, video, git('rev-parse', 'HEAD').strip(), git

    def test_staged_and_unstaged_source_changes_mark_build_dirty(self):
        with self.repository() as (repo, video, revision, git):
            self.assertEqual(source_metadata(), {'source_commit': revision, 'source_dirty': False})
            (video / 'source.py').write_text('changed\n')
            self.assertTrue(source_metadata()['source_dirty'])
            git('add', 'video/source.py')
            self.assertEqual(git('diff', '--name-only'), '')
            self.assertEqual(source_metadata(), {'source_commit': revision, 'source_dirty': True})

    def test_new_source_is_dirty_but_ignored_outputs_and_sibling_work_are_not(self):
        with self.repository() as (repo, video, revision, git):
            (repo / 'unrelated-work.py').write_text('sibling work\n')
            (video / 'build').mkdir()
            (video / 'build/artifact.txt').write_text('generated\n')
            self.assertFalse(source_metadata()['source_dirty'])
            (video / 'new_module.py').write_text('new source\n')
            self.assertTrue(source_metadata()['source_dirty'])
