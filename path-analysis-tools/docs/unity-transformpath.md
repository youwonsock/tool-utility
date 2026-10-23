# 현재 TransformPath 적용 예제

이 문서는 호출 에이전트를 위한 매핑 안내입니다. 제품 코어는 Unity API나 MCP SDK를 가져오지 않으며, 각 Unity MCP의 메서드명은 에이전트가 실제 기능 조회로 결정합니다.

## 매핑

- run 노드: 독립 루트 GameObject와 MultiPathData.
- segment 노드: run 아래 GameObject와 PathData.
- point 노드: segment 아래 제어점 Transform.
- segments order: MultiPathData의 직렬화된 `_segments`와 각 `_providerObject` 참조.
- points order: PathData의 직렬화된 `_pathPoints` Transform 참조.
- rebuild: 모든 PathData Rebuild → MultiPathData Rebuild → IsReady/PathLength/참조 재조회.

snapshot의 position은 선택 루트 기준 좌표입니다. 실제 적용은 root.TransformPoint로 world 위치를 얻거나 대상 parent의 역변환으로 localPosition을 계산합니다. 기존 부모의 회전·스케일을 무시하고 snapshot position을 그대로 localPosition에 대입하면 안 됩니다. 프레임이 달라졌으면 다시 계획합니다.

새 PathData 기본값은 Linear, TimeBased, 5초, 선형 TimeCurve, 빈 이벤트 목록입니다. 새 MultiPath 구간은 provider 이동 설정을 사용하고 PreservePreviousSpeed=false로 설정합니다. 구간 경계에는 각 구간 소유의 별도 Transform을 같은 위치에 둡니다.

기존 수정은 이동 설정과 `_pathEvents`, 다른 컴포넌트와 외부 참조를 변경하지 않습니다. 점의 기존 이름을 재사용하고 원하는 `_pathPoints` 배열만 명시적으로 작성합니다. GameObject 삭제 전에 공유 참조와 ownership을 확인합니다.

## 영속화

에디터의 SerializedObject/SerializedProperty 또는 같은 역할의 MCP 기능으로 authoring 필드를 저장하고 Undo/prefab override/dirty 처리를 수행합니다. `ConfigureControlPoints()`와 `ConfigureSegments()`의 런타임 메모리 설정만으로 완료 처리하지 않습니다.

런타임 검증과 저장·재로드 검증을 분리합니다. 임시 additive 씬에서 검사할 경우 원래 활성 씬과 dirty 상태를 보존하고, 기존 변경을 저장하거나 되돌리지 않습니다. 테스트용 씬과 객체만 정리합니다.

특정 프로젝트의 네임스페이스·asmdef·필드가 다른 경우 소스/Inspector를 먼저 확인해 매핑합니다. 이 안내를 실행할 수 없는 MCP라면 계산된 PathPlan과 필요한 capability 목록을 반환하고 씬 변경을 시도하지 않습니다.
