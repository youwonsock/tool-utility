# 동봉 런타임 관리

런타임 생성은 개발자가 Windows x64 또는 Mac Apple Silicon에서 수행합니다. CPython 3.14 이상의 빌드용 Python과 OS 기본 curl, Git이 필요합니다. Mac 생성에는 codesign이 사용됩니다. 사용자 실행에는 이 개발 환경이 필요하지 않습니다.

```bash
python tools/build_runtime.py --refresh --archive
```

이 명령은 고정된 SHA-256의 CPython 3.14.8 / 20261013 배포와 의존성 휠을 받습니다. 패키지는 네이티브 동봉 Python에 오프라인으로 설치하고, GUI와 MCP가 공유하는 FFmpeg 한 벌과 라이선스를 수집합니다. Mac 실행 파일과 라이브러리의 서명을 보존하거나 ad-hoc 서명합니다.

GitHub Actions의 **Video tools distribution**을 refresh 옵션으로 실행하면 두 OS의 런타임 아카이브를 생성합니다. 아티팩트에서 받은 Windows와 Mac tar.gz를 다음 명령에 함께 전달합니다.

```bash
python tools/sync_runtime.py /path/to/windows-x64.tar.gz /path/to/macos-arm64.tar.gz --stage
```

동기화는 해시와 런타임 입력을 검사하고 Git 실행 권한·심볼릭 링크를 보존합니다. Windows에서 Mac 런타임을 동기화할 때도 Git 인덱스에 정확한 권한과 링크를 저장합니다.

```bash
python tools/build_runtime.py --audit --git
```

현재 플랫폼의 배포 파일이 manifest와 일치하며 Git에 모두 포함되어 있는지 확인합니다. `.pyd`는 필수 네이티브 배포 파일이므로 무시하지 않습니다. 런타임 내용에는 줄바꿈 변환을 적용하지 않으며 파일당 100 MiB를 넘지 않아야 합니다.

런타임 입력 해시는 생성 코드·런타임 출처·패키지 잠금·휠 출처만 포함합니다. GUI·MCP·공용 처리 소스의 기능 변경에는 런타임을 다시 생성하지 않습니다. 의존성을 바꾸면 두 런타임을 함께 갱신하고 검증한 뒤 병합합니다.

프로젝트의 기능 테스트·픽스처·자가 테스트 코드는 유지하지 않습니다. 상시 CI는 배포 생성과 완전성을 검사하며, 기능 변경 완료 시 임시 환경에서 실제 GUI·MCP·미디어 작업을 검증하고 커밋·OS·해시·결과를 기록합니다.
