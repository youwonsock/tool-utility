# Path Analysis Tools

> **개발 중입니다.** 실제 영상 기반 품질 평가와 게임 내 동작 검증이 끝나지 않았으며, 기능과 입출력 형식이 바뀔 수 있습니다.

격자 이미지에서 에이전트가 읽은 상대 3D 관측값을 정리하고, 씬 편집 계획을 계산하는 독립 도구입니다. **이미지의 의미 해석과 실제 Unity MCP 호출은 호출한 에이전트가 담당**합니다. 도구는 모델 서버·Unity·AI 호스트에 연결하지 않습니다.

## 바로 실행

Windows x64는 `run.bat`, Mac Apple Silicon은 `run_mac.command`를 사용합니다. 자체 Python·Pillow·JSON Schema·MCP 런타임을 포함하므로 시스템 Python이나 video-tools 설치가 필요하지 않습니다. 전체 폴더를 함께 이동하세요.

```sh
./run_mac.command cli --workspace "/path/to/work" server_info
./run_mac.command configure --workspace "/path/to/work" --output mcp-config.local.json
./run_mcp.command --workspace "/path/to/work"
```

Windows에서는 동일 인수를 `run.bat`와 `run_mcp.bat`에 전달합니다. `configure` 결과의 `mcpServers` 항목을 사용하는 클라이언트에 등록합니다. 폴더를 이동하면 연결 설정을 다시 생성하세요. GUI는 없으며 CLI의 이미지 결과는 PNG 파일, MCP의 이미지 결과는 표준 image content로 제공됩니다.

## 작업 흐름

1. video-tools의 PNG/JPG와 격자 정보를 작업 폴더에 둡니다.
2. `inspect_sheets`로 명시적 유효 셀을 등록하고 `read_frame`으로 셀을 봅니다.
3. 에이전트가 배경 이동·상대 높이·행동을 해석해 `ObservationSet`을 작성합니다.
4. `calculate_path`와 `preview_path`로 경로를 검토합니다.
5. 에이전트가 자신의 엔진 도구로 현재 씬을 읽어 `SceneSnapshot`과 명시적 대응표를 작성합니다.
6. `plan_scene_edits`와 `verify_scene_apply`로 사전 조건·지원 기능을 확인합니다.
7. 에이전트가 의존성 순서대로 적용하고 실제 참조를 `ApplyLog`에 기록합니다.
8. 실제 씬을 다시 읽어 `verify_scene_apply`로 검증합니다. 부분 실패는 새 스냅샷으로 재계획합니다.

## 실행 가능한 예제

`examples`는 카메라 이탈·고저 변화를 포함한 **합성 자료**입니다. examples 폴더를 작업 위치에 복사한 뒤 아래 순서로 실행합니다.

```sh
./run_mac.command cli --workspace "/path/to/copied-examples" inspect_sheets --input inspect-request.json
./run_mac.command cli --workspace "/path/to/copied-examples" read_frame --input frame-request.json
./run_mac.command cli --workspace "/path/to/copied-examples" calculate_path --input calculate-request.json
./run_mac.command cli --workspace "/path/to/copied-examples" preview_path --input preview-request.json
./run_mac.command cli --workspace "/path/to/copied-examples" plan_scene_edits --input edit-request.json
./run_mac.command cli --workspace "/path/to/copied-examples" verify_scene_apply --input verify-request.json
```

CLI는 `--input`을 생략하면 stdin에서 같은 JSON 요청을 읽습니다. MCP의 각 도구는 같은 요청을 `{"request": {...}}`로 받습니다. 문서 인수는 JSON 객체 또는 workspace 안의 JSON 경로입니다. `output`은 결과 문서를 원자적으로 저장하며, 이미지 CLI에서는 필수입니다. 미리보기 이미지와 프레임 출력은 `.png`를 사용합니다. 에이전트별 플러그인이나 프로젝트 전용 스킬은 필수 조건이 아닙니다.

정확한 필드와 적용 규칙은 [계약](docs/contract.md), [호스트 중립 작업 절차](docs/workflow.md), [현재 TransformPath 통합 예제](docs/unity-transformpath.md), [검증 상태](docs/verification.md)를 참고하세요. 배포 JSON Schema는 `src/path_analysis_tools/schemas`에 있습니다.

## 개발과 배포 검증

```sh
./portable/macos-arm64/python/bin/python3.14 -I -B -X utf8 tools/run_tests.py
./portable/macos-arm64/python/bin/python3.14 -I -B -X utf8 tools/verify_smoke.py
./portable/macos-arm64/python/bin/python3.14 -I -B -X utf8 tools/export_contracts.py --check
./portable/macos-arm64/python/bin/python3.14 -I -B -X utf8 tools/build_runtime.py --audit
./portable/macos-arm64/python/bin/python3.14 -I -B -X utf8 tools/verify_portable.py --output "/path/to/new-portable-check"
```

Windows의 인터프리터 위치는 `portable/windows-x64/python/python.exe`입니다. 각 런타임의 manifest에 고정 버전·공급자·배포 파일 해시가 있고 licenses에 고지가 있습니다. 런타임에는 GUI용 Tcl/Tk와 FFmpeg가 포함되지 않습니다.

런타임을 다시 만들 때는 GitHub Actions의 **Path analysis tools**를 refresh 옵션으로 실행하고, 두 OS의 아티팩트를 `python tools/sync_runtime.py <windows-x64.tar.gz> <macos-arm64.tar.gz> --stage`로 반영합니다. `tools`의 `runtime-assets.json`, `requirements-runtime.lock`, `wheel-sources.json`에 고정 입력이 있습니다. 입력을 바꾸면 두 런타임을 함께 다시 만듭니다.

선택적으로 `pip install .`로 개발용 Python 패키지를 설치할 수 있습니다. CLI는 entry point, MCP는 `python -m path_analysis_tools.mcp_server --workspace ...`로 실행합니다. 폴더 배포의 기본 실행은 항상 동봉 런타임입니다.
