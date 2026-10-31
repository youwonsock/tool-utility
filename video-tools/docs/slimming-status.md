# 경량화 작업 현황

기록일: 2026-10-31. 대상 브랜치: `video-tools-slim`(기준 `main` `e9c57da`, 구현 커밋 `0616b84`).

설치 없이 `run.bat`·`run_mac.command`로 실행하는 방식은 유지하고 런타임과 내려받는 양을 줄이는 작업입니다. **두 런타임을 재생성해 반영했고, 완료 검증이 남아 있습니다.** 이 문서는 작업이 끝나면 결과를 [완료 검증 기록](verification.md)에 옮기고 삭제합니다.

## 현재 상태

- 소스, 빌드 스크립트, CI, 문서, 재생성한 런타임은 커밋되어 있습니다.
- 최소 FFmpeg는 [Release `video-tools-ffmpeg-7.1.5-1`](https://github.com/youwonsock/tool-utility/releases/tag/video-tools-ffmpeg-7.1.5-1)에 게시했고, 원본 소스도 함께 올렸습니다. URL과 SHA-256은 `runtime-assets.json`에 고정되어 있습니다.
- README는 작업 완료 후의 배포 방식과 코덱 범위를 설명합니다. 앱 ZIP Release는 아직 없습니다.

**완료 검증 전에는 `main`에 병합하지 않습니다.** README가 안내하는 배포물은 병합 후 태그로 게시합니다.

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
| Windows 런타임 | 182MB → 68MB, 파일 1,631개 | CI 재생성 결과를 저장소에 반영 |
| Mac 런타임 | 146MB → 80MB, 파일 1,714개 | CI 재생성 결과를 저장소에 반영 |
| Mac FFmpeg 빌드 | 작업 전체 3분 5초 | Release 아카이브 4,268,958바이트 |
| Windows FFmpeg 빌드 | 작업 전체 13분 41초 | Release 아카이브 5,176,512바이트 |
| Mac ZIP | 31,195,536바이트(약 30MiB) | 저장소 복사본에서 같은 입력으로 재생성한 사전 점검 런타임으로 생성 |

Windows ZIP의 최종 크기는 아직 측정하지 않았습니다. 푸시 후 CI의 `video-release-*` 아티팩트로 확인합니다.

## 검증 범위

로컬 Windows에서 확인했습니다.

- smoke 검사 통과: 저장소 런타임, 패키지 정리 사본, ZIP을 푼 폴더 각각
- 샘플 12개의 조회·추출·재인코딩과 회전 인식: **기존 범용 FFmpeg로** 통과
- `read_image` 축소: 2000×1000 → 1280×640, 1000×2000 → 640×1280, 최대 64 지정 시 64×32, 101×77은 크기 유지
- `install_ffmpeg()`: 대체 아카이브 설치, 해시 불일치와 고정값 누락 거부
- 구성 요소 이름: 7.1.5 소스와 대조. 기존 빌드 목록과 비교하면 의도한 `libdav1d`만 다름

로컬 Mac(macOS 26.6.2 ARM64)에서 확인했습니다. 첫 항목은 반영한 저장소 런타임, 나머지는 저장소 복사본의 사전 점검 결과입니다.

- 저장소 런타임의 `--audit --git`, smoke 검사. 두 런타임의 Git 항목과 모드가 manifest와 일치하는 것
- 게시된 Release의 FFmpeg를 내려받은 `--refresh`와 `--audit`, smoke 검사, 샘플 14개의 코덱 검사
- ZIP을 `ditto`로 한글·공백 경로에 푼 뒤 실행 권한, FFmpeg 서명, 심볼릭 링크 4개, smoke 검사
- 크롭·회전 3종·반전·배속 2종·크기 조절·전체 조합 편집
- `read_image`의 RGBA·팔레트·16비트 PNG와 JPG 축소. 오류와 크기만 확인했고 색은 비교하지 않았습니다.
- `wrapped_avframe`을 뺀 빌드를 `--ffmpeg`로 지정하면 smoke 검사가 실패하는 것

CI에서 확인했습니다.

- [Run #55](https://github.com/youwonsock/tool-utility/actions/runs/41170129103): Windows Server 2025와 macOS 15.8.2에서 새 FFmpeg로 빌드, smoke 검사 18개 항목, 코덱 샘플 14개 통과
- [런타임 재생성](https://github.com/youwonsock/tool-utility/actions/runs/41171551818): 두 OS의 `--refresh`와 smoke 검사 17개 항목 통과

아직 확인하지 못했습니다.

- 커밋된 런타임의 두 OS CI `--audit --git`, 최소 FFmpeg를 넣은 두 OS의 GUI 조작
- 브라우저로 받은 Mac ZIP의 격리 속성과 보안 승인 동작, 앱 ZIP Release 게시 작업
- JPEG 품질 설정이 Pillow 85에서 FFmpeg `-q:v 4`로 바뀌어 달라진 결과 바이트의 화질

## 남은 작업

순서대로 진행합니다. `ffmpeg-sources.json`을 바꾸면 게시한 아카이브가 거부되므로 코덱 목록을 바꾸려면 FFmpeg 빌드, Release, 런타임 재생성을 다시 진행합니다.

1. **완료 검증.** 두 OS CI의 `--audit --git`·smoke 검사, Windows GUI, Mac ZIP(사람이 Mac에서 확인), 크기 전후를 `verification.md`에 새 날짜로 기록하고 이 문서를 삭제합니다.
2. **병합과 배포.** PR로 `main`에 병합한 뒤 `video-tools-v*` 태그로 OS별 ZIP을 게시하고 브랜치를 삭제합니다. 태그 전에 workflow의 Release 설명 문구에 코덱 범위 변경을 추가합니다.

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
