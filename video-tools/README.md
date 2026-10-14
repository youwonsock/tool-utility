# Video Tools

Windows x64·Mac Apple Silicon에서 영상 이미지 추출과 영상 편집을 수행하는 GUI 및 로컬 MCP 도구입니다. 필요한 Python·Tcl/Tk·Pillow·MCP SDK·FFmpeg가 이 폴더에 포함되어 있습니다.

## 바로 실행

1. 저장소를 Git clone하거나 GitHub **Code → Download ZIP**으로 받습니다.
2. ZIP으로 받았다면 운영체제 기본 압축 해제 도구로 전체를 풉니다.
3. Windows는 **run.bat**, Mac은 **run_mac.command**를 더블클릭합니다.

Python·FFmpeg 설치, pip 실행, 가상환경 생성이나 최초 실행 다운로드가 필요하지 않습니다. 도구 폴더 전체를 함께 보관하고 이동하세요. 런처 실행 시 콘솔 또는 Terminal 창이 함께 열립니다.

지원 대상은 **Windows 10 이상 x64**와 **macOS 15 이상 Apple Silicon**입니다. Intel Mac·Linux 배포는 제공하지 않습니다. Mac은 native ARM64 런타임을 사용하므로 Rosetta가 필요하지 않습니다.

Mac에서 최초 실행 시 보안 승인을 요구하면 시스템 설정 → 개인정보 보호 및 보안에서 해당 실행을 승인합니다. 프로그램은 내부용 ad-hoc 서명을 사용합니다.

## GUI

- 영상의 시작·끝 시간과 양의 실수 초 단위 추출 간격을 지정합니다.
- PNG/JPG 개별 이미지 또는 2 × 2·3 × 3 격자 이미지를 저장합니다.
- 최종 이미지·격자 셀 크기, 원본 비율, 여백, 파일명과 덮어쓰기를 설정합니다.
- 미리보기에서 합성 크기를 확인하고 진행률을 보거나 작업을 취소할 수 있습니다.
- 영상 편집 탭에서 구간 자르기·크롭·크기 조절·회전·반전·배속·음소거·CRF를 설정합니다.

원본과 기존 출력은 기본적으로 덮어쓰지 않습니다. 설정은 Windows의 `%APPDATA%\VideoToImage\settings.json`, Mac의 `~/Library/Application Support/VideoToImage/settings.json`에 저장합니다. 현재 설정 형식만 읽으며 구형 설정 변환이나 이전 경로의 자동 이전은 수행하지 않습니다.

## MCP 연결

GUI의 **MCP 연결 설정**에서 영상 작업 폴더를 선택하고 생성한 JSON을 사용하는 MCP 클라이언트에 등록합니다. 연결 설정은 현재 동봉 Python과 서버 소스의 절대 경로를 사용합니다. 도구 폴더를 이동했다면 설정을 다시 생성하세요.

GUI 없이 설정을 생성할 수도 있습니다.

Windows:

```bat
portable\windows-x64\python\python.exe -I -B -X utf8 launch.py configure --workspace "D:\VideoWorkspace" --output mcp-config.local.json
```

Mac:

```bash
./portable/macos-arm64/python/bin/python3.14 -I -B -X utf8 launch.py configure --workspace "$HOME/VideoWorkspace" --output mcp-config.local.json
```

서버를 직접 실행할 때는 Windows의 `run_mcp.bat --workspace "D:\VideoWorkspace"` 또는 Mac의 `./run_mcp.command --workspace "$HOME/VideoWorkspace"`를 사용합니다. 기본 실행은 동봉 FFmpeg를 사용하며 명시적인 `--ffmpeg` 경로 지정도 지원합니다.

| 도구 | 기능 |
| --- | --- |
| `server_info` | 서버 기능·버전·입력 제한 조회 |
| `list_media` | 작업 폴더의 영상·이미지 목록 |
| `inspect_video` | 영상 길이·크기·프레임률·오디오 정보 |
| `start_frame_extraction` | 개별·격자 이미지 추출 |
| `start_video_edit` | 영상 구간·크롭·회전·크기·배속·오디오 편집 |
| `get_job` | 작업 진행률·결과·오류 조회 |
| `list_jobs` | 현재 서버의 작업 목록 |
| `cancel_job` | 대기·실행 중인 작업 취소 |
| `read_image` | 결과 이미지 확인 |

작업을 시작하면 `job_id`가 반환됩니다. `get_job`으로 완료를 확인한 뒤 결과 파일을 사용합니다. GUI와 MCP의 작업 기록은 각 프로세스에서 독립적으로 관리됩니다.

서버는 선택한 작업 폴더 안의 로컬 파일만 처리합니다. 최대 동시 작업은 2개, 대기 포함 8개이며 추출 샘플 10,000개, 프레임당 64메가픽셀, FFmpeg 작업 시간 1시간으로 제한합니다.

## 구성과 갱신

- `src/video_tools/core`: 공용 영상 처리·작업·설정
- `src/video_tools/gui`, `src/video_tools/mcp`: GUI와 MCP 인터페이스
- `src/video_tools/platforms`: Windows와 macOS 동작
- `portable/windows-x64`, `portable/macos-arm64`: 각 OS의 동봉 런타임
- `tools`: 고정된 런타임 생성·동기화
- `docs`: 개발 안내와 완료 검증 기록

공용 소스 변경은 다음 실행부터 바로 반영됩니다. 런타임이나 의존성 변경은 두 플랫폼의 검증된 파일을 함께 갱신합니다. 개발 절차는 [런타임 관리](docs/runtime-management.md)를 참고하세요.

프로젝트 테스트 소스·픽스처·자가 테스트는 포함하지 않습니다. 완료 검증은 별도의 임시 환경에서 수행하며 결과를 기록합니다.

런타임의 `manifest.json`에는 버전·출처·의존성·파일 해시·권한이, `licenses`에는 Python과 네이티브 의존성·패키지·FFmpeg 고지와 출처가 포함되어 있습니다.
