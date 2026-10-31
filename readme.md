# tool-utility

Unreal 플러그인과 Unity Editor 도구에서 분리된 기타 작업 편의 도구를 보관하는 Git 저장소입니다.

각 최상위 툴 폴더는 독립적으로 사용할 수 있도록 자체 README와 전용 무시 규칙을 가집니다. 저장소 루트에서는 공통 빌드나 설치를 수행하지 않고, 필요한 툴 폴더의 문서를 따라 사용합니다.

## 보관 중인 툴

| 툴 | 요약 | 문서 |
| --- | --- | --- |
| Video Tools | Windows x64·Mac Apple Silicon 무설치 GUI 이미지 추출·영상 편집 및 공용 처리 코드를 사용하는 MCP 도구 9개 | [툴 README](./video-tools/README.md) · [MCP 설정 및 사용](./video-tools/README.md#mcp-연결) |
| Path Analysis Tools (개발 중) | 격자 이미지 셀·상대 3D 경로 계산·중립 씬 편집 계획과 적용 검증을 제공하는 독립 CLI/MCP | [툴 README](./path-analysis-tools/README.md) |
| Agent Delegation | Codex·OpenCode·Claude Code·Kilo에 작업을 위임하고, 범위 보호·증거 검수·별도 검증 후 Git에 반영하는 로컬 플러그인 및 MCP 도구 12개 | [툴 README](./agent-delegation/README.md) · [운영·백업](./agent-delegation/docs/operations.md) |

## 폴더 운영

- 툴별 소스, 의존성, 실행 방법은 각 툴 폴더 안에서 관리합니다.
- 엔진 생성물, 가상환경, 빌드 결과물, 테스트 출력물은 각 폴더의 무시 규칙으로 제외합니다.
- 새로운 기타 툴은 독립 실행에 필요한 README와 전용 무시 규칙을 갖춘 최상위 폴더로 추가합니다.

