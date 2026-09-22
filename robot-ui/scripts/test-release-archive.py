import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('archive', Path(__file__).with_name('package-release-archive.py'))
archive = importlib.util.module_from_spec(spec)
spec.loader.exec_module(archive)
TAG, COMMIT = 'v1.0.2-test.8', 'a' * 40


class ArchiveTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        self.report = {'status': 'passed', 'checks': [{'name': n, 'status': 'passed'} for n in sorted(archive.CHECKS)]}
        self.installer = self.source / 'Setup.1.0.2-test.8.exe'
        self.installer.write_bytes(b'synthetic installer, no native code')
        (self.source / 'packaged-runtime.json').write_text(json.dumps(self.report))
        manifest = {'tag': TAG, 'version': TAG[1:], 'commit': COMMIT, 'platform': {'os': 'win32', 'arch': 'x64'},
                    'nativeChecks': self.report, 'artifacts': [
                        {'name': p.name, 'bytes': p.stat().st_size, 'sha256': archive.digest(p)}
                        for p in [self.installer, self.source / 'packaged-runtime.json']]}
        (self.source / 'build-info.json').write_text(json.dumps(manifest))
        (self.source / 'SHA256SUMS.txt').write_text(''.join(archive.digest(p) + '  ' + p.name + '\n' for p in sorted(self.source.iterdir())))
        self.release = {'tag_name': TAG, 'target_commitish': COMMIT, 'draft': True, 'prerelease': True,
                        'assets': [{'id': i, 'name': p.name, 'state': 'uploaded', 'size': p.stat().st_size,
                                    'digest': 'sha256:' + archive.digest(p), 'download_count': 0}
                                   for i, p in enumerate(sorted(self.source.iterdir()))]}

    def test_verified_archive_has_one_installer_and_exact_bytes(self):
        archive.validate_release(self.release, TAG, COMMIT)
        _, names = archive.validate_files(self.source, self.release, TAG, COMMIT)
        output = self.root / archive.ARCHIVE
        checksum = archive.create_archive(self.source, output, TAG, COMMIT, names)
        with zipfile.ZipFile(output) as result:
            self.assertEqual(sum(n.endswith('.exe') for n in result.namelist()), 1)
            self.assertEqual(len(result.namelist()), 5)
            self.assertEqual(result.read('streaming_app/' + self.installer.name), self.installer.read_bytes())
            self.assertIn(COMMIT, result.read('streaming_app/README.txt').decode('utf-8-sig'))
        self.assertEqual(checksum.read_text(), archive.digest(output) + '  streaming_app.zip\n')
        with self.assertRaises(FileExistsError):
            archive.create_archive(self.source, output, TAG, COMMIT, names)

    def test_release_guard_rejects_wrong_commit_public_release_and_existing_zip(self):
        for changes in [{'target_commitish': 'b' * 40}, {'draft': False}, {'prerelease': False},
                        {'assets': self.release['assets'] + [{'name': archive.ARCHIVE}]}]:
            with self.assertRaises(ValueError):
                archive.validate_release({**self.release, **changes}, TAG, COMMIT)
        with self.assertRaises(ValueError):
            archive.validate_release(self.release, 'main', COMMIT)

    def test_modified_installer_and_extra_file_are_rejected(self):
        original = self.installer.read_bytes()
        self.installer.write_bytes(b'tampered')
        with self.assertRaises(ValueError):
            archive.validate_files(self.source, self.release, TAG, COMMIT)
        self.installer.write_bytes(original)
        (self.source / '.env').write_text('DO_NOT_PACKAGE=synthetic')
        with self.assertRaises(ValueError):
            archive.validate_files(self.source, self.release, TAG, COMMIT)

    def test_untrusted_digest_is_rejected(self):
        self.release['assets'][0]['digest'] = 'sha256:' + '0' * 64
        with self.assertRaises(ValueError):
            archive.validate_files(self.source, self.release, TAG, COMMIT)

    def test_download_counts_do_not_invalidate_pinned_artifacts(self):
        changed = copy.deepcopy(self.release)
        changed['assets'][0]['download_count'] += 1
        self.assertEqual(archive.asset_identity(changed), archive.asset_identity(self.release))
        changed['assets'][0]['digest'] = 'different'
        self.assertNotEqual(archive.asset_identity(changed), archive.asset_identity(self.release))


if __name__ == '__main__':
    unittest.main()
