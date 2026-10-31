# 경량화 작업 현황

기록일: 2026-10-31. 대상 브랜치: `video-tools-slim`(기준 `main` `e9c57da`, 구현 커밋 `0616b84`).

설치 없이 `run.bat`·`run_mac.command`로 실행하는 방식은 유지하고 런타임과 내려받는 양을 줄이는 작업입니다. **아직 진행 중이며 커밋된 `portable/` 런타임은 줄어들지 않았습니다.** 이 문서는 작업이 끝나면 결과를 [완료 검증 기록](verification.md)에 옮기고 삭제합니다.

## 현재 상태

- 소스, 빌드 스크립트, CI, 문서 변경은 커밋되어 있습니다.
- 런타임 입력이 바뀌어 `build_runtime.py --audit`은 런타임을 다시 만들기 전까지 `Runtime inputs changed`로 실패합니다. push 실행 [40720460586](https://github.com/youwonsock/tool-utility/actions/runs/40720460586)의 실패도 이 단계에서 났습니다.
- `runtime-assets.json`에 FFmpeg 아카이브의 `ffmpeg_url`·`ffmpeg_sha256`이 아직 없어 refresh는 고정값을 요구하며 실패합니다. 의도한 동작입니다.
- README는 작업 완료 후의 배포 방식과 코덱 범위를 설명합니다. Release도 아직 없습니다.

**런타임을 다시 만들기 전에는 `main`에 병합하지 않습니다.** 병합하면 `main`의 CI가 실패하고 README가 아직 없는 배포물을 안내하게 됩니다.

## 완료한 작업

| 단계 | 내용 | 주요 파일 |
| --- | --- | --- |
| 패키지 정리 | 잠금 목록에서 cryptography·cffi·pycparser·PyJWT·Pillow·imageio-ffmpeg 제거, `--no-deps` 설치, 표준 라이브러리 일부와 pywin32 부속 제거, 정리 후 GUI·MCP import 검사 | `tools/build_runtime.py`, `tools/requirements-runtime.lock`, `tools/wheel-sources.json` |
| OS별 ZIP | 감사를 통과한 런타임만 포장, Mac 실행 권한·심볼릭 링크 기록, `video-tools-v*` 태그로 Release 게시 | `tools/package_release.py`, `.github/workflows/video-tools.yml` |
| Pillow 대체 | `read_image`와 smoke 검사를 동봉 FFmpeg로 처리 | `src/video_tools/core/backend.py`, `src/video_tools/mcp/server.py`, `tools/verify_smoke.py` |
| 최소 FFmpeg | FFmpeg 7.1.5·x264·dav1d·zlib 소스 고정, 정적 빌드, 구성 요소와 링크 검사, 지원 코덱 검사 | `tools/build_ffmpeg.py`, `tools/ffmpeg-sources.json`, `tools/make_codec_samples.py` |

계획에서 달라진 점은 다음과 같습니다.

- 샘플 생성용 `make_codec_samples.py`와 검사할 FFmpeg를 지정하는 `verify_smoke.py --ffmpeg`를 추가했습니다. FFmpeg 빌드 작업은 이 옵션으로 smoke 검사 전체와 코덱 검사를 새 빌드에서 실행합니다.
- 사전 점검에서 찾은 문제 두 가지를 수정했습니다. 재생성 검사가 최소 빌드에 없는 `libx264rgb`를 요구해 refresh가 실패했고, `wrapped_avframe` 디코더가 없어 smoke 검사의 테스트 영상을 만들지 못했습니다. 디코더 추가로 `ffmpeg-sources.json`이 바뀌었으므로 Run #52의 Mac 아카이브는 더 이상 사용할 수 없습니다.
- FFmpeg 빌드는 수동 실행만 지원합니다. 소스 변경 시 자동 실행은 넣지 않았습니다.
- `verification.md`의 Pillow·imageio-ffmpeg 기록은 과거 실행의 증거라서 그대로 두었습니다.
- `mp2`·`pcm_s24be` 디코더와 각 샘플을 추가했습니다. 없으면 MPEG-2와 MP2의 MKV, ProRes와 24비트 PCM의 MOV에서 음소거하지 않은 편집이 알기 어려운 오류로 실패합니다.

## 측정값

| 항목 | 결과 | 조건 |
| --- | --- | --- |
| Windows 런타임 | 182MB → 139MB | 현재 런타임 사본에 패키지 정리만 적용. FFmpeg는 기존 84MB |
| Windows ZIP | 68 MiB | 정리하지 않은 현재 런타임으로 생성 |
| Mac FFmpeg 빌드 | 약 3분 | CI 아티팩트 18,698,770바이트. 수정 후 로컬 빌드의 FFmpeg 아카이브는 4,271,063바이트 |
| Windows FFmpeg 빌드 | 성공, 작업 전체 13분 18초 | 아티팩트가 올라가지 않아 크기 미확인 |
| Mac 런타임 | 146MB → 80MB, FFmpeg 47MiB → 9.1MiB | 저장소 복사본에서 최소 FFmpeg로 재생성한 사전 점검 결과 |
| Mac ZIP | 31,198,534바이트(약 30MiB) | 같은 사전 점검 런타임으로 생성 |

최소 FFmpeg를 넣은 Windows 런타임과 ZIP의 최종 크기는 아직 측정하지 않았습니다.

## 검증 범위

로컬 Windows에서 확인했습니다.

- smoke 검사 통과: 저장소 런타임, 패키지 정리 사본, ZIP을 푼 폴더 각각
- 샘플 12개의 조회·추출·재인코딩과 회전 인식: **기존 범용 FFmpeg로** 통과
- `read_image` 축소: 2000×1000 → 1280×640, 1000×2000 → 640×1280, 최대 64 지정 시 64×32, 101×77은 크기 유지
- `install_ffmpeg()`: 대체 아카이브 설치, 해시 불일치와 고정값 누락 거부
- 구성 요소 이름: 7.1.5 소스와 대조. 기존 빌드 목록과 비교하면 의도한 `libdav1d`만 다름

로컬 Mac(macOS 26.6.2 ARM64)의 저장소 복사본에서 확인했습니다. FFmpeg URL·해시 고정은 복사본에만 임시로 넣었습니다.

- 최소 FFmpeg 빌드, 정리를 적용한 `--refresh`와 `--audit`, smoke 검사, 샘플 14개의 코덱 검사
- ZIP을 `ditto`로 한글·공백 경로에 푼 뒤 실행 권한, FFmpeg 서명, 심볼릭 링크 4개, smoke 검사
- 크롭·회전 3종·반전·배속 2종·크기 조절·전체 조합 편집
- `read_image`의 RGBA·팔레트·16비트 PNG와 JPG 축소. 오류와 크기만 확인했고 색은 비교하지 않았습니다.
- `wrapped_avframe`을 뺀 빌드를 `--ffmpeg`로 지정하면 smoke 검사가 실패하는 것

CI에서 확인했습니다.

- [Run #52](https://github.com/youwonsock/tool-utility/actions/runs/40913483093): 수정 전 소스로 Mac 빌드와 코덱 검사 통과, Windows 빌드 통과

아직 확인하지 못했습니다.

- 현재 소스로 빌드한 두 OS FFmpeg의 CI 검사. Windows는 코덱 검사와 smoke 검사를 한 번도 통과하지 않았습니다.
- Windows 런타임의 `--refresh`·`--audit`, 최소 FFmpeg를 넣은 두 OS의 GUI 조작
- 브라우저로 받은 Mac ZIP의 격리 속성과 보안 승인 동작, Release 게시 작업
- JPEG 품질 설정이 Pillow 85에서 FFmpeg `-q:v 4`로 바뀌어 달라진 결과 바이트의 화질

## 남은 작업

순서대로 진행합니다. `ffmpeg-sources.json`을 바꾸면 이미 만든 아카이브는 거부되므로, FFmpeg를 다시 빌드한 뒤에는 코덱 목록을 바꾸지 않습니다.

1. **Windows 코덱 검사 단계 수정(workflow 반영, CI 미확인).** 원인은 `tar -C`가 `$RUNNER_TEMP`의 백슬래시 경로를 열지 못하는 것이었습니다. 로컬에서 같은 단계가 같은 exit code 2로 실패했습니다. 경로를 슬래시로 바꾼 뒤 workflow의 단계 내용을 그대로 꺼내 실행하니 샘플 12개가 통과했습니다. 다만 새 FFmpeg가 아니라 기존 FFmpeg로 만든 대체 아카이브로 시험했습니다. 아카이브 업로드도 코덱 검사 앞으로 옮겨, 검사가 실패해도 빌드 결과가 남습니다.
2. **FFmpeg 빌드 재실행.** Actions에서 브랜치 `video-tools-slim`, ffmpeg 옵션으로 실행하고 두 OS의 smoke 검사, 코덱 검사 14개, 아카이브 크기를 확인합니다.
3. **FFmpeg Release 게시와 고정.** 두 아카이브와 `ffmpeg-sources/`의 원본 소스를 한 Release에 올리고 URL·SHA-256을 `runtime-assets.json`에 고정합니다. GPL 대응 소스를 함께 게시해야 합니다. 태그는 배포 작업이 실행되지 않도록 `video-tools-ffmpeg-7.1.5-1`처럼 `video-tools-v*`와 겹치지 않게 짓습니다.
4. **런타임 한 번 재생성.** refresh 옵션으로 실행하고 `sync_runtime.py --stage`로 반영해 한 커밋으로 만듭니다. 재생성은 Git 기록을 늘리므로 앞 단계가 끝난 뒤 한 번만 실행합니다.
5. **완료 검증.** 두 OS CI의 `--audit --git`·smoke 검사, Windows GUI, Mac ZIP(사람이 Mac에서 확인), 크기 전후를 `verification.md`에 새 날짜로 기록하고 이 문서를 삭제합니다.
6. **병합과 배포.** PR로 `main`에 병합한 뒤 `video-tools-v*` 태그로 OS별 ZIP을 게시하고 브랜치를 삭제합니다. 태그 전에 workflow의 Release 설명 문구에 코덱 범위 변경을 추가합니다.

재생성 후에는 저장소의 FFmpeg가 최소 빌드가 되어 샘플을 만들 수 없습니다. 이후 FFmpeg를 다시 빌드할 때는 샘플을 보관해 두거나 다른 전체 기능 FFmpeg를 지정해야 합니다.

## 추가 개선 후보

이번 작업의 완료 조건은 아닙니다.

- **라이선스 경로 줄이기:** ZIP의 최장 항목이 162자입니다. 긴 폴더에 풀면 Windows 경로 길이 제한에 걸리며, 실제로 임시 폴더에서 오류 206이 났습니다. 배포하지 않는 pip의 고지가 `licenses/python-build-standalone/install` 아래에 중복되어 있어 정리할 수 있습니다.
- **`path-analysis-tools` 경량화:** 비슷한 동봉 런타임이 234MB입니다. Pillow는 실제로 사용하므로 별도 측정이 필요합니다.
- **Git 기록 용량:** pack이 약 116MiB입니다. 파일을 지워도 줄지 않으며 기록을 다시 쓰거나 런타임을 Git 밖으로 옮겨야 합니다.
- **추가 압축:** FFmpeg `--enable-small`, 표준 라이브러리 zip 묶음. 효과와 동작 차이를 측정한 뒤 결정합니다.
- **CI 정비:** Node 20 사용 중단 경고가 나오는 `checkout@v4`, `setup-python@v5`, `upload-artifact@v4`를 갱신합니다.
- **x264 소스 고정:** GitLab 아카이브 바이트가 바뀌면 해시 검증이 실패합니다. 같은 커밋인지 확인한 뒤 다시 고정합니다.

## 지원 범위 변경

최소 FFmpeg로 바꾸면 [런타임 관리](runtime-management.md#최소-ffmpeg) 목록 밖 코덱의 영상은 더 이상 열리지 않습니다. 이 변경은 사용자에게 보이는 동작 변화이므로 Release 설명에도 적습니다.
