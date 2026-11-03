# 동봉 런타임 관리

사용자는 저장소에 커밋된 런타임을 그대로 쓰므로 별도 배포물을 만들지 않습니다. 이 문서는 런타임과 FFmpeg를 다시 만드는 개발자용 절차입니다.

## 언제 다시 만드나

- **다시 만들지 않음:** GUI·MCP·공용 처리 소스의 기능 변경. 다음 실행부터 바로 반영됩니다.
- **다시 만듦:** 생성 코드, Python 배포본, 패키지 잠금, 휠 출처, FFmpeg 소스 고정이 바뀔 때. 이 값들의 해시가 런타임 입력 해시입니다.
- 두 OS의 런타임은 항상 함께 갱신하고 검증한 뒤 병합합니다.

## 런타임 생성

준비물은 CPython 3.14 이상(빌드용), OS 기본 curl, Git이고, Mac은 codesign을 씁니다. 사용자 실행에는 필요 없습니다.

```bash
python tools/build_runtime.py --refresh --archive
```

- 고정된 SHA-256의 CPython 3.14.10 / 20261026과 잠금 목록의 휠만 `--no-deps`로 오프라인 설치합니다. stdio 서버가 쓰지 않는 선택 의존성(HTTP OAuth용 cryptography, PyJWT 등)은 넣지 않습니다.
- 설치 후 GUI·MCP 진입점을 실제로 import해 검사하고, FFmpeg 한 벌과 라이선스를 모읍니다. Mac 실행 파일은 서명을 보존하거나 ad-hoc 서명합니다.
- 제외 대상은 `prune_build_files()`에 있습니다: CPython 테스트, `ensurepip`·`venv`·`pydoc_data`·`turtledemo`, 쓰지 않는 SQLite 바인딩, Windows `libs`, pywin32의 COM·Pythonwin·ISAPI·데모. MCP가 쓰는 `win32` 모듈과 DLL은 남깁니다.

두 OS의 런타임은 GitHub Actions **Video tools distribution**을 refresh 옵션으로 실행해 만들고, 받은 아카이브를 함께 동기화합니다.

```bash
python tools/sync_runtime.py /path/to/windows-x64.tar.gz /path/to/macos-arm64.tar.gz --stage
python tools/build_runtime.py --audit --git
```

- 동기화는 해시와 입력을 검사하고, 실행 권한과 심볼릭 링크를 manifest대로 Git에 저장합니다. Windows에서 Mac 런타임을 동기화해도 권한과 링크가 유지됩니다.
- `--audit --git`은 현재 플랫폼의 파일이 manifest와 일치하고 모두 Git에 있는지 확인합니다. `.pyd`도 필수 파일입니다.
- 런타임에는 줄바꿈 변환을 적용하지 않으며, 파일 하나가 100 MiB를 넘으면 안 됩니다.

## 최소 FFmpeg

`tools/build_ffmpeg.py`가 `tools/ffmpeg-sources.json`에 고정된 FFmpeg·x264·dav1d·zlib 소스로 정적 빌드합니다. README의 지원 형식에 필요한 프로토콜·디먹서·먹서·코덱·필터만 켜고, 빌드 뒤 구성 요소와 시스템 라이브러리 외 링크가 없는지 확인합니다.

지원 범위를 바꿀 때:

1. `components`를 고칩니다.
2. **Video tools distribution**을 ffmpeg 옵션으로 실행합니다. Windows는 MSYS2 MINGW64, Mac은 Xcode와 Homebrew의 nasm·meson·ninja·pkg-config로 빌드합니다. `tools/codec-samples.json`의 코덱 샘플로 smoke 검사, 코덱별 조회·추출·재인코딩, 회전 인식을 확인합니다.
3. `video-ffmpeg-*` 아티팩트의 두 아카이브와 `ffmpeg-sources/`의 원본 소스를 하나의 GitHub Release에 올립니다. 원본 소스는 GPL 대응용입니다.
4. 두 아카이브의 URL과 SHA-256을 `tools/runtime-assets.json`의 `ffmpeg_url`, `ffmpeg_sha256`에 고정하고 런타임을 다시 만듭니다. 로컬에서는 같은 해시의 파일을 `--ffmpeg <tar.gz>`로 넘길 수 있습니다.

- 코덱 샘플을 바꿔야 하면 전체 기능 FFmpeg로 `tools/make_codec_samples.py <FFmpeg> <폴더> --archive codec-samples.tar.gz`를 실행해 새 Release에 올리고 `tools/codec-samples.json`에 고정합니다.
- 원본 주소가 실패하거나 해시가 다르면 `tools/ffmpeg-source-mirror.json`의 Release에서 같은 해시의 소스를 받습니다. 소스 고정을 바꾸면 이 주소도 바꿉니다.

## 검사

상시 CI는 배포 파일 감사와 다음 세 검사를 두 OS에서 실행합니다. 테스트 영상은 동봉 FFmpeg로 임시 폴더에 만듭니다.

| 검사 | 확인 내용 |
| --- | --- |
| `tools/verify_smoke.py` | 실제 stdio MCP로 9개 도구, PNG/JPG 격자 추출, 편집, 원본·기존 출력 보존, 경로 경계, 대기 작업 취소 |
| `tools/run_tests.py` | 크기 계산, FFmpeg 필터·명령, 입력 검증, 작업 관리, 파일 게시, 설정 (FFmpeg·창 없이) |
| `tools/verify_gui.py` | 실제 창의 위젯을 코드로 조작: 추출, 격자, 취소, 편집, 회전 영상, 스크롤, MCP 설정 창, 설정 복원. 파일 선택·알림 창은 코드로 대체 |

수동 실행(Mac, Windows는 `./portable/windows-x64/python/python.exe`):

```bash
./portable/macos-arm64/python/bin/python3.14 -I -B -X utf8 tools/verify_smoke.py --report /tmp/video-tools-smoke.json
./portable/macos-arm64/python/bin/python3.14 -I -B -X utf8 tools/run_tests.py
./portable/macos-arm64/python/bin/python3.14 -I -B -X utf8 tools/verify_gui.py
```

- 보고서는 제품 폴더 밖에 저장합니다. CI는 두 OS의 보고서를 `video-smoke-*` 아티팩트로 남깁니다.
- 실제 마우스 조작, 새 clone, 오프라인 검증은 변경 범위에 맞춰 따로 하고 [검증 기록](verification.md)에 커밋·OS·해시·결과를 남깁니다.

## 의존성 점검

주간 **Dependency check** 워크플로가 `tools/check_updates.py`로 다음을 확인해 GitHub 이슈 하나에 기록하고, 확인할 것이 없으면 이슈를 닫습니다.

- 잠금 목록과 Agent Delegation `package-lock.json`의 OSV 취약점
- FFmpeg·x264·dav1d·zlib·Python 배포본의 새 버전(OSV가 추적하지 않아 버전만 비교)

공개 저장소는 60일간 활동이 없으면 예약 실행이 멈추므로, 멈추면 Actions 화면에서 다시 켭니다. Agent Delegation의 npm 의존성은 Dependabot도 확인합니다.
