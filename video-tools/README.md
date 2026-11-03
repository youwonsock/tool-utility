# Video Tools

영상에서 이미지를 추출하고 영상을 편집하는 GUI와 로컬 MCP 도구입니다. Python, Tcl/Tk, MCP SDK와 필요한 기능만 넣은 FFmpeg가 이 폴더에 들어 있어 따로 설치할 것이 없습니다.

## 바로 실행

```bash
git clone https://github.com/youwonsock/tool-utility.git
```

`video-tools` 폴더에서 Windows는 **run.bat**, Mac은 **run_mac.command**를 더블클릭합니다.

- 지원 OS: Windows 10 이상 x64, macOS 15 이상 Apple Silicon(Rosetta 불필요). Intel Mac과 Linux는 지원하지 않습니다.
- 저장소 전체를 받으므로 약 370MB를 씁니다. 도구 폴더는 통째로 보관하고 옮기세요.
- 실행하면 콘솔 또는 Terminal 창이 함께 열립니다.
- Mac에서 처음 실행할 때 보안 승인을 요구하면 시스템 설정 → 개인정보 보호 및 보안에서 승인합니다(내부용 ad-hoc 서명).

| 구분 | 지원 형식 |
| --- | --- |
| 입력 컨테이너 | mp4, mov, m4v, mkv, webm, avi |
| 영상 코덱 | H.264, HEVC, VP8, VP9, AV1, MPEG-4 Part 2, MPEG-1/2, MJPEG, ProRes |
| 오디오 코덱 | AAC, MP2, MP3, Opus, Vorbis, AC-3, E-AC-3, FLAC, ALAC, PCM |
| 출력 | PNG·JPG 이미지, H.264·AAC MP4 |

목록에 없는 코덱의 영상은 열 수 없습니다.

## GUI

- **이미지 추출:** 시작·끝 시간과 추출 간격(초)을 정해 PNG/JPG 개별 이미지나 2 × 2·3 × 3 격자 이미지로 저장합니다. 크기, 원본 비율, 여백, 파일명, 덮어쓰기를 설정하고 미리보기로 확인합니다.
- **영상 편집:** 구간 자르기, 크롭, 크기 조절, 회전, 반전, 배속, 음소거, CRF를 설정합니다.
- 진행률을 보며 작업을 취소할 수 있습니다. 원본과 기존 출력은 기본적으로 덮어쓰지 않습니다.
- 설정은 Windows `%APPDATA%\VideoToImage\settings.json`, Mac `~/Library/Application Support/VideoToImage/settings.json`에 저장합니다. 현재 형식만 읽으며, 형식에 맞지 않는 값은 기본값으로 바뀝니다.

## MCP 연결

GUI의 **MCP 연결 설정**에서 작업 폴더를 고르고, 생성된 JSON을 MCP 클라이언트에 등록합니다. 설정에는 동봉 Python과 서버 소스의 절대 경로가 들어가므로, 도구 폴더를 옮겼다면 다시 생성하세요.

GUI 없이 만들 수도 있습니다.

```bat
portable\windows-x64\python\python.exe -I -B -X utf8 launch.py configure --workspace "D:\VideoWorkspace" --output mcp-config.local.json
```

```bash
./portable/macos-arm64/python/bin/python3.14 -I -B -X utf8 launch.py configure --workspace "$HOME/VideoWorkspace" --output mcp-config.local.json
```

서버를 직접 실행하려면 `run_mcp.bat --workspace <폴더>`(Windows) 또는 `./run_mcp.command --workspace <폴더>`(Mac)를 씁니다. `--ffmpeg`로 다른 FFmpeg를 지정할 수 있습니다.

| 도구 | 기능 |
| --- | --- |
| `server_info` | 서버 기능·버전·입력 제한 |
| `list_media` | 작업 폴더의 영상·이미지 목록 |
| `inspect_video` | 길이·크기·프레임률·오디오 정보 |
| `start_frame_extraction` | 개별·격자 이미지 추출 |
| `start_video_edit` | 구간·크롭·회전·크기·배속·오디오 편집 |
| `get_job`, `list_jobs` | 작업 진행률·결과·오류, 작업 목록 |
| `cancel_job` | 대기·실행 중 작업 취소 |
| `read_image` | 결과 이미지 확인 |

- 작업을 시작하면 `job_id`가 나옵니다. `get_job`으로 완료를 확인한 뒤 결과를 씁니다. GUI와 MCP의 작업 기록은 서로 독립입니다.
- 선택한 작업 폴더 안의 로컬 파일만 처리합니다.
- 제한: 동시 작업 2개(대기 포함 8개), 추출 샘플 10,000개, 프레임당 64메가픽셀, FFmpeg 작업 1시간.

## 구성과 개발

| 경로 | 내용 |
| --- | --- |
| `src/video_tools/core` | 공용 영상 처리·작업·설정 |
| `src/video_tools/gui`, `src/video_tools/mcp` | GUI와 MCP 인터페이스 |
| `src/video_tools/platforms` | Windows·macOS별 동작 |
| `portable/windows-x64`, `portable/macos-arm64` | 동봉 런타임(버전·해시·라이선스는 각 `manifest.json`과 `licenses`) |
| `tools` | 런타임·FFmpeg 생성, 동기화, 검사 |
| `tests` | FFmpeg와 창 없이 실행하는 단위 테스트 |

- 소스 변경은 다음 실행부터 바로 반영됩니다. 런타임과 의존성을 바꿀 때는 [런타임 관리](docs/runtime-management.md)를 따릅니다.
- CI는 두 OS에서 동봉 런타임으로 `tools/verify_smoke.py`(실제 MCP), `tools/run_tests.py`(단위 테스트), `tools/verify_gui.py`(GUI 위젯 조작)를 실행합니다.
- 실제 실행 결과와 확인하지 않은 범위는 [검증 기록](docs/verification.md)에 있습니다.
