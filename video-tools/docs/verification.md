# 검증 기록

현재 런타임은 2026-10-31 의존성 갱신본이며, 같은 날 두 OS의 CI와 macOS 새 clone에서 모든 검사를 통과했습니다. 지원 기준은 Windows 10 이상 x64, macOS 15 이상 Apple Silicon입니다.

## 현재 런타임

- Python 3.14.10 / python-build-standalone 20261026, Tcl/Tk 9.0.4, MCP SDK 1.30.0, certifi 2026.10.23
- FFmpeg 7.1.5 최소 정적 빌드: [Release `video-tools-ffmpeg-7.1.5-1`](https://github.com/youwonsock/tool-utility/releases/tag/video-tools-ffmpeg-7.1.5-1). x264, dav1d, zlib을 포함한 원본 소스를 함께 게시했습니다.
- Pillow, imageio-ffmpeg, cryptography, cffi, pycparser, PyJWT는 경량화 때 뺐습니다.
- 새 clone은 약 370MB이고 그중 `.git`이 83MB입니다.
- 버전·파일 해시·권한은 각 런타임의 `manifest.json`에 있습니다.

## 검증 결과 (2026-10-31)

| 환경 | 확인 내용 | 결과 |
| --- | --- | --- |
| CI: Windows Server 2025, macOS 15.8.2 | `--audit --git`, 단위 테스트, smoke 검사, 코덱 샘플 14개, GUI 검사 46개 항목, 이동·오프라인 검사 | 통과 |
| macOS 26.6.2 ARM64, 한글·공백 경로에 새 clone | `run_mac.command` 창 실행, `run_mcp.command` 초기화·종료 코드 0, audit, smoke 18개 항목, 코덱 샘플 14개, 실행 후 Git 상태 깨끗함 | 통과 |
| macOS 26.6.2 실제 마우스·키보드 조작 | 화면 배치, 스크롤, 파일 선택·저장 창, 경고·완료 알림, 격자 추출(1920 × 1080 1장, 112장), 취소 후 출력 없음, 크롭·2배속 편집, MCP 설정 창, 설정 복원 | 통과 |

- clone한 파일에는 격리 속성이 없어 브라우저 다운로드의 보안 승인을 거치지 않습니다.
- 단위 테스트가 실제로 오류를 잡는지 핵심 규칙 12곳을 일부러 바꿔 확인했습니다.
- 실제 조작에서 찾아 고친 문제는 세 가지입니다: 시작 버튼 글자가 배경과 같은 흰색, 작업 시작 후 탭 내용이 사라짐, MCP 설정 창이 런타임 오류를 알리지 않음. 앞의 두 가지는 `verify_gui.py`가 이제 검사합니다.

실행 기록:

- [FFmpeg 빌드](https://github.com/youwonsock/tool-utility/actions/runs/41170129103): 두 OS에서 smoke 18개 항목, 코덱 샘플 14개 통과
- [FFmpeg 재빌드 경로 확인](https://github.com/youwonsock/tool-utility/actions/runs/41193825550): [`video-tools-codec-samples-1`](https://github.com/youwonsock/tool-utility/releases/tag/video-tools-codec-samples-1) 샘플로 통과 (게시하지 않음)
- [런타임 재생성](https://github.com/youwonsock/tool-utility/actions/runs/41171551818)과 [커밋된 런타임](https://github.com/youwonsock/tool-utility/actions/runs/41172190715): 두 OS에서 통과

## 확인하지 않은 범위

- **Windows:** 실제 GUI 조작과 새 clone 실행은 하지 않았고 CI 결과만 확인했습니다. Windows 10 클라이언트 실기기도 확인하지 않았습니다.
- **실제 입력:** Mac 외에는 실제 마우스 입력, 화면 배치, 파일 선택·알림 창을 확인하지 않았습니다. CI GUI 검사는 이 창들을 코드로 대체합니다. 버튼의 실제 색도 검사하지 않습니다.
- **`read_image`:** RGBA·팔레트·16비트 PNG와 JPG의 축소만 확인했고 색은 비교하지 않았습니다. JPEG 설정이 Pillow 85에서 FFmpeg `-q:v 4`로 바뀌어 결과 바이트가 이전과 다릅니다.
- **지원 형식:** [지원 목록](runtime-management.md#최소-ffmpeg) 밖 코덱의 영상은 열리지 않습니다. 목록에 없는 오디오 코덱은 추출은 되지만 음소거하지 않은 편집은 실패합니다.
- **설정:** 크기 모드와 출력 방식의 저장값이 바뀌어, 이전 설정 파일의 두 값은 한 번 기본값으로 돌아갑니다.

## 남은 개선 후보

- **MSYS2 환경:** Windows FFmpeg 빌드에 MINGW64 사용 중단 경고가 나옵니다. UCRT64로 옮기면 FFmpeg를 다시 검증해야 합니다.
- **Windows 경로 길이:** 최장 경로가 181자라 clone 위치가 깊으면 Git 경로 길이 제한에 걸릴 수 있습니다. `licenses/python-build-standalone/install` 아래 중복된 pip 고지를 정리하면 줄일 수 있습니다.

## 이전 기록

- **2026-10-14 무설치 배포 검증 (경량화 전 런타임):** CPython 3.14.8, FFmpeg 7.1 기반이었습니다. Windows Server 2025, macOS 15.7.9, macOS 26.6.2에서 새 clone과 GitHub ZIP을 한글·공백 경로로 옮겨 오프라인으로 실행해 기능 검증 45/45를 통과했습니다. GUI와 MCP에 같은 입력을 주어 PNG·JPG 격자·편집 영상의 디코딩 결과가 같음을 확인했습니다. 기록: [Windows](https://github.com/youwonsock/tool-utility/actions/runs/38522182617), [Mac](https://github.com/youwonsock/tool-utility/actions/runs/38521357680), [상시 CI](https://github.com/youwonsock/tool-utility/actions/runs/38521361049), [런타임 재생성](https://github.com/youwonsock/tool-utility/actions/runs/38520736707).
- **2026-10-31 경량화:** 런타임 저장소 크기를 Windows 182MB → 68MB, Mac 146MB → 80MB로 줄이고, OS별 ZIP과 앱 Release 대신 저장소 clone 하나로 배포하도록 정리했습니다.
- **2026-10-31 Git 기록 재작성:** 최신 커밋에 없는 과거 런타임 파일 817개를 기록에서 지웠습니다. 모든 커밋 해시가 바뀌었고 최신 트리 해시 `f33032652accc04fc2025f23fa93b3c67c36ae29`는 그대로입니다. 새 clone은 약 514MB에서 348MB로 줄었습니다. 재작성 전 커밋은 런타임 파일 일부가 없어 실행할 수 없습니다. Release 태그 2개는 같은 이름으로 옮겼습니다.
