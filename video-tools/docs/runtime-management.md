# 동봉 런타임 관리

진행 중인 경량화의 상태와 남은 작업은 [경량화 작업 현황](slimming-status.md)에 있습니다.

런타임 생성은 개발자가 Windows x64 또는 Mac Apple Silicon에서 수행합니다. CPython 3.14 이상의 빌드용 Python과 OS 기본 curl, Git이 필요합니다. Mac 생성에는 codesign이 사용됩니다. 사용자 실행에는 이 개발 환경이 필요하지 않습니다.

```bash
python tools/build_runtime.py --refresh --archive
```

이 명령은 고정된 SHA-256의 CPython 3.14.8 / 20261013 배포와 의존성 휠을 받습니다. 패키지는 `--no-deps`로 잠금 목록만 네이티브 동봉 Python에 오프라인으로 설치합니다. MCP의 HTTP OAuth용 cryptography·PyJWT처럼 stdio 서버가 불러오지 않는 선택 의존성은 잠금 목록에 넣지 않습니다. 생성 후에는 GUI·MCP 진입점을 실제로 import해 정리 결과를 검사합니다. GUI와 MCP가 공유하는 FFmpeg 한 벌과 라이선스를 수집하고, Mac 실행 파일과 라이브러리의 서명을 보존하거나 ad-hoc 서명합니다.

런타임에서 제외하는 항목은 `prune_build_files()`에 있습니다. 대상은 CPython 회귀 테스트·테스트 확장 모듈, `ensurepip`·`venv`·`pydoc_data`·`turtledemo`, 사용하지 않는 SQLite 바인딩, Windows 확장 빌드용 `libs`, pywin32의 COM·Pythonwin·ISAPI·데모입니다. pywin32에서 MCP가 사용하는 `win32` API 모듈과 DLL은 유지합니다.

## 최소 FFmpeg

동봉 FFmpeg는 `tools/build_ffmpeg.py`가 `tools/ffmpeg-sources.json`에 고정된 FFmpeg·x264·dav1d·zlib 소스로 정적 빌드합니다. 필요한 프로토콜·디먹서·먹서·코덱·필터만 활성화하며, 빌드 후 FFmpeg 목록 출력으로 구성 요소를 확인하고 시스템 라이브러리 외 링크가 없는지 검사합니다.

- 입력: mp4·mov·m4v·mkv·webm·avi 컨테이너, H.264·HEVC·VP8·VP9·AV1(dav1d)·MPEG-4 Part 2·MPEG-1/2·MJPEG·ProRes 영상, AAC·MP2·MP3·Opus·Vorbis·AC-3·E-AC-3·FLAC·ALAC·PCM 오디오, PNG·JPG 이미지
- 출력: PNG·JPG 이미지, H.264(libx264)·AAC MP4

목록 밖 코덱이나 컨테이너의 영상은 열 수 없습니다. 지원 범위를 바꾸면 `components`를 수정하고 두 FFmpeg와 두 런타임을 함께 다시 생성합니다.

1. GitHub Actions의 **Video tools distribution**을 ffmpeg 옵션으로 실행합니다. Windows는 MSYS2 MINGW64, Mac은 Xcode와 Homebrew의 nasm·meson·ninja·pkg-config로 빌드합니다. 이 작업은 `tools/make_codec_samples.py`로 지원 코덱마다 샘플 영상을 만들고, `verify_smoke.py --codec-matrix <폴더> --ffmpeg <새 FFmpeg>`로 새 빌드의 smoke 검사 전체와 코덱별 조회·추출·재인코딩, 회전 인식을 검사합니다. 샘플 인코딩에는 libx265·libvpx·libaom 등을 갖춘 전체 기능 FFmpeg가 필요하므로, 커밋된 런타임이 이미 최소 빌드라면 다른 전체 기능 FFmpeg를 지정합니다.
2. `video-ffmpeg-*` 아티팩트의 `ffmpeg-windows-x64.tar.gz`, `ffmpeg-macos-arm64.tar.gz`와 `ffmpeg-sources/`의 원본 소스 아카이브를 하나의 GitHub Release에 함께 올립니다. 소스 아카이브는 GPL 대응 소스로 바이너리와 함께 게시합니다.
3. 두 아카이브의 URL과 SHA-256을 `tools/runtime-assets.json`의 각 프로필 `ffmpeg_url`, `ffmpeg_sha256`에 고정한 뒤 아래 refresh로 런타임을 생성합니다. 로컬 개발에서는 같은 해시의 파일을 `--ffmpeg <tar.gz>`로 전달할 수 있습니다.

x264 소스는 stable 브랜치 커밋의 GitLab 아카이브입니다. 아카이브 바이트가 바뀌어 해시가 맞지 않으면 같은 커밋인지 확인한 뒤 새 해시로 다시 고정합니다.

GitHub Actions의 **Video tools distribution**을 refresh 옵션으로 실행하면 두 OS의 런타임 아카이브를 생성합니다. 아티팩트에서 받은 Windows와 Mac tar.gz를 다음 명령에 함께 전달합니다.

```bash
python tools/sync_runtime.py /path/to/windows-x64.tar.gz /path/to/macos-arm64.tar.gz --stage
```

동기화는 해시와 런타임 입력을 검사하고 Git 실행 권한·심볼릭 링크를 보존합니다. Windows에서 Mac 런타임을 동기화할 때도 Git 인덱스에 정확한 권한과 링크를 저장합니다.

```bash
python tools/build_runtime.py --audit --git
```

현재 플랫폼의 배포 파일이 manifest와 일치하며 Git에 모두 포함되어 있는지 확인합니다. `.pyd`는 필수 네이티브 배포 파일이므로 무시하지 않습니다. 런타임 내용에는 줄바꿈 변환을 적용하지 않으며 파일당 100 MiB를 넘지 않아야 합니다.

런타임 입력 해시는 생성 코드·런타임 출처·패키지 잠금·휠 출처·FFmpeg 소스 고정만 포함합니다. GUI·MCP·공용 처리 소스의 기능 변경에는 런타임을 다시 생성하지 않습니다. 의존성을 바꾸면 두 런타임을 함께 갱신하고 검증한 뒤 병합합니다.

상시 CI는 배포 생성·완전성 감사와 `tools/verify_smoke.py`의 핵심 기능 검사를 실행합니다. 테스트 영상은 동봉 FFmpeg로 임시 폴더에 생성합니다. 실제 stdio MCP 연결로 9개 도구, PNG/JPG 격자 추출, 구간·크기·음소거 편집, 원본·기존 출력 보존, 경로 경계와 동기화된 대기 작업 취소를 확인합니다. GUI 창 조작은 이 검사에 포함하지 않습니다.

## 플랫폼별 배포 ZIP

`tools/package_release.py`는 현재 OS의 런타임을 감사한 뒤 `.build/artifacts/video-tools-<profile>.zip`을 만듭니다. ZIP에는 실행 소스·문서·해당 OS 런처와 런타임만 들어갑니다. Mac ZIP은 manifest의 실행 권한과 심볼릭 링크를 Unix 속성으로 기록합니다. 상시 CI는 두 OS의 ZIP을 `video-release-*` 아티팩트로 보관합니다. `video-tools-v*` 태그를 push하면 같은 ZIP을 해당 태그의 GitHub Release에 게시합니다.

Mac에서 수동 실행:

```bash
./portable/macos-arm64/python/bin/python3.14 -I -B -X utf8 tools/verify_smoke.py --report /tmp/video-tools-smoke.json
```

Windows PowerShell에서 수동 실행:

```powershell
./portable/windows-x64/python/python.exe -I -B -X utf8 tools/verify_smoke.py --report "$env:TEMP/video-tools-smoke.json"
```

보고서는 제품 폴더 밖에 저장해야 하며 실패 시 비정상 종료 코드와 MCP stderr·오류 정보를 포함합니다. CI는 두 OS의 보고서를 `video-smoke-*` 아티팩트로 보관합니다. 임시 미디어는 검사 종료 시 정리합니다. 실제 GUI, 새 clone·ZIP 이동, 오프라인 격리 검증은 기능 변경 범위에 맞춰 별도로 수행하고 커밋·OS·해시·결과를 기록합니다. 기존 날짜의 완료 검증 기록은 당시 실행의 증거로 유지합니다.
