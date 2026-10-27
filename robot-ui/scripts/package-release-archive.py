"""Add a named ZIP to a verified draft, entirely on the GitHub runner."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
import zipfile

LEGACY_CHECKS = {'runtime', 'packaged-layout', 'ffmpeg-pcm', 'ffplay', 'windows-pause-resume',
                 'sharp', 'onnx-models', 'ocr-pipeline', 'packaged-native-bindings'}
CHECKS = LEGACY_CHECKS | {'audio-send-cadence'}
ARCHIVE = 'streaming_app.zip'


def require(condition, message):
    if not condition:
        raise ValueError(message)


def required_checks(tag):
    match = re.fullmatch(r'v(\d+)\.(\d+)\.(\d+)-test\.(\d+)', tag)
    require(match is not None, 'Expected an exact test release tag')
    # Published older artifacts cannot gain a check retroactively. New releases
    # must not downgrade to the legacy report just because it still says passed.
    version = tuple(int(part) for part in match.groups())
    return CHECKS if version >= (1, 1, 0, 7) else LEGACY_CHECKS


def command(*args):
    # Do not surface CLI authentication details in failure output.
    result = subprocess.run(args, capture_output=True, text=True, timeout=240)
    require(result.returncode == 0, f'{args[0]} {args[1]} failed')
    return result.stdout


def api(path):
    return json.loads(command('gh', 'api', path))


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def asset_identity(release):
    return sorted((a['id'], a['name'], a['size'], a.get('digest'), a['state']) for a in release['assets'])


def validate_release(release, tag, commit):
    require(re.fullmatch(r'v\d+\.\d+\.\d+-test\.\d+', tag) is not None, 'Expected an exact test release tag')
    require(re.fullmatch(r'[0-9a-f]{40}', commit) is not None, 'Invalid commit')
    require(release.get('tag_name') == tag and release.get('target_commitish') == commit,
            'Release does not match the pinned tag commit')
    require(release.get('draft') is True and release.get('prerelease') is True, 'Expected a draft prerelease')
    names = [asset['name'] for asset in release['assets']]
    require(len(names) == len(set(names)), 'Duplicate release asset names')
    require(ARCHIVE not in names and ARCHIVE + '.sha256' not in names, 'Archive already exists; refusing to overwrite')


def validate_files(directory, release, tag, commit):
    expected_checks = required_checks(tag)
    names = [f'Setup.{tag[1:]}.exe', 'build-info.json', 'packaged-runtime.json', 'SHA256SUMS.txt']
    require(sorted(p.name for p in directory.iterdir()) == sorted(names), 'Unexpected downloaded files')
    assets = {a['name']: a for a in release['assets']}
    for name in names:
        path, asset = directory / name, assets[name]
        require(path.is_file() and not path.is_symlink(), 'Invalid input file')
        require(asset['state'] == 'uploaded' and path.stat().st_size == asset['size'], 'Asset size mismatch')
        require(asset.get('digest') == 'sha256:' + digest(path), 'Asset SHA-256 mismatch')
    checksums = {}
    for line in (directory / 'SHA256SUMS.txt').read_text().splitlines():
        checksum, name = line.split('  ', 1)
        require(name in names and name not in checksums, 'Invalid checksum manifest entry')
        require(checksum == digest(directory / name), 'Build checksum mismatch')
        checksums[name] = checksum
    require(set(checksums) == set(names) - {'SHA256SUMS.txt'}, 'Incomplete checksum manifest')
    manifest = json.loads((directory / 'build-info.json').read_text())
    require(manifest['tag'] == tag and manifest['version'] == tag[1:] and manifest['commit'] == commit,
            'Build manifest does not match release')
    require(manifest['platform'] == {'os': 'win32', 'arch': 'x64'}, 'Expected Windows x64')
    require({a['name'] for a in manifest['artifacts']} == {names[0], 'packaged-runtime.json'}, 'Unexpected build artifacts')
    for artifact in manifest['artifacts']:
        require(artifact['sha256'] == digest(directory / artifact['name'])
                and artifact['bytes'] == (directory / artifact['name']).stat().st_size, 'Build artifact mismatch')
    report = json.loads((directory / 'packaged-runtime.json').read_text())
    for report in [report, manifest['nativeChecks']]:
        require(report['status'] == 'passed' and len(report['checks']) == len(expected_checks), 'Incomplete native checks')
        require({c['name'] for c in report['checks']} == expected_checks
                and all(c['status'] == 'passed' for c in report['checks']), 'Native checks failed')
    return manifest, names


def create_archive(directory, output, tag, commit, names):
    readme = f'''streaming_app — Windows x64
版本：{tag[1:]}
应用提交：{commit}

解压后运行 Setup.{tag[1:]}.exe。升级前退出旧应用并备份 %APPDATA%\\robot-live-ui\\。
安装器已内置前端、后端、Electron、VC++ x64 运行库、OCR 模型/字典/原生库、FFmpeg/FFplay 和音频暂停组件。
无需单独安装 Node.js、Python 或另行下载 VC++ 安装程序。API 调用仍需联网并填写自己的有效凭据。

三组设置：巡游讲解 / 过渡音频与手动播报 / 弹幕回复。
千问使用完整 API Key，模型 qwen3.8-flash。
DeepSeek 支持官方和火山方舟。选择方舟时填写方舟模型 ID，例如已开通的 deepseek-v4-flash-ga-260731。
解锁后点击“使用本组豆包密钥”，再保存本组全部设置，即可复用已有方舟密钥；无需填写官方 deepseek-chat。

本 ZIP 只包含一个安装器、原始构建和校验报告、本说明；没有重复打包安装器内部的依赖。
个人密钥、日志和业务素材不包含在内。Windows CI 已验证 OCR、音频和启动连接；现场设备仍需实机验收。
'''
    with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_STORED) as archive:
        for name in names:
            entry = zipfile.ZipInfo('streaming_app/' + name)
            with (directory / name).open('rb') as source, archive.open(entry, 'w', force_zip64=True) as dest:
                shutil.copyfileobj(source, dest)
        archive.writestr('streaming_app/README.txt', readme.encode('utf-8-sig'))
    with zipfile.ZipFile(output) as archive:
        require(archive.testzip() is None, 'ZIP integrity check failed')
        require(len(archive.namelist()) == len(names) + 1, 'Unexpected ZIP entries')
        for name in names:
            with archive.open('streaming_app/' + name) as source:
                h = hashlib.sha256()
                for block in iter(lambda: source.read(1024 * 1024), b''):
                    h.update(block)
            require(h.hexdigest() == digest(directory / name), 'ZIP content differs from verified release')
    checksum = output.with_name(ARCHIVE + '.sha256')
    checksum.write_text(digest(output) + '  ' + ARCHIVE + '\n')
    return checksum


def main():
    require(os.environ.get('GITHUB_ACTIONS') == 'true'
            and os.environ.get('GITHUB_EVENT_NAME') == 'workflow_dispatch', 'Run only via the archive workflow')
    tag, repo = os.environ['RELEASE_TAG'], os.environ['GITHUB_REPOSITORY']
    require(re.fullmatch(r'v\d+\.\d+\.\d+-test\.\d+', tag) is not None, 'Invalid test tag')
    require(re.fullmatch(r'[\w.-]+/[\w.-]+', repo) is not None, 'Invalid repository')
    commit = command('git', 'rev-parse', '--verify', f'refs/tags/{tag}^{{commit}}').strip()
    releases = api(f'repos/{repo}/releases?per_page=100')
    matches = [r for r in releases if r['tag_name'] == tag]
    require(len(matches) == 1, 'Expected exactly one release for this tag')
    release = matches[0]
    validate_release(release, tag, commit)
    with tempfile.TemporaryDirectory(prefix='streaming-app-') as temp:
        directory = Path(temp) / 'source'
        directory.mkdir()
        names = [f'Setup.{tag[1:]}.exe', 'build-info.json', 'packaged-runtime.json', 'SHA256SUMS.txt']
        args = ['gh', 'release', 'download', tag, '--repo', repo, '--dir', str(directory)]
        for name in names:
            args.extend(['--pattern', name])
        command(*args)
        manifest, names = validate_files(directory, release, tag, commit)
        require(manifest['workflow']['repository'] == repo, 'Build came from another repository')
        run_id = str(manifest['workflow']['runId'])
        require(run_id.isdigit(), 'Invalid build run ID')
        run = api(f'repos/{repo}/actions/runs/{run_id}')
        require(run['head_sha'] == commit and run['status'] == 'completed'
                and run['conclusion'] == 'success', 'Source build did not pass at this commit')
        output = Path(temp) / ARCHIVE
        checksum = create_archive(directory, output, tag, commit, names)
        current = api(f'repos/{repo}/releases/{release["id"]}')
        validate_release(current, tag, commit)
        require(asset_identity(current) == asset_identity(release), 'Release assets changed while preparing ZIP')
        command('gh', 'release', 'upload', tag, str(output), str(checksum), '--repo', repo)
        for attempt in range(6):
            uploaded = api(f'repos/{repo}/releases/{release["id"]}')
            uploaded_names = {a['name'] for a in uploaded['assets'] if a.get('digest') and a['state'] == 'uploaded'}
            if {output.name, checksum.name} <= uploaded_names:
                break
            if attempt < 5:
                time.sleep(2)
        for file in [output, checksum]:
            asset = next(a for a in uploaded['assets'] if a['name'] == file.name)
            require(asset['state'] == 'uploaded' and asset['size'] == file.stat().st_size
                    and asset.get('digest') == 'sha256:' + digest(file), 'Uploaded ZIP/checksum mismatch')
        print(f'Verified {ARCHIVE} for {tag}, application commit {commit}')
        print(uploaded['html_url'])


if __name__ == '__main__':
    main()
