export type NodeKind =
  | "thesis"
  | "concept"
  | "system"
  | "tool"
  | "practice"
  | "risk";

export type Domain =
  | "reasoning"
  | "agents"
  | "memory"
  | "safety"
  | "product"
  | "infrastructure";

export type RelationKind =
  | "documents"
  | "plans"
  | "contains"
  | "implements"
  | "depends_on"
  | "calls"
  | "reads_from"
  | "writes_to"
  | "produces"
  | "tests"
  | "references"
  | "precedes"
  | "blocks"
  | "supersedes"
  | "same_as"
  | "mentions"
  | "related_to"
  | "supports"
  | "extends"
  | "requires"
  | "uses"
  | "mitigates"
  | "risks"
  | "contradicts";

export type RelationLayer = "structural" | "explicit" | "inferred" | "display";

export type GitHubNodeSource = {
  provider: "github";
  repositoryId: string;
  repositoryOwner: string;
  repositoryName: string;
  relativePath: string;
  commitSha: string;
  sourceUrl: string;
};

export type KnowledgeNode = {
  id: string;
  label: string;
  shortLabel: string;
  kind: NodeKind;
  domain: Domain;
  summary: string;
  insight: string;
  tags: string[];
  metrics?: {
    communityId: string;
    centrality: number;
    degree: number;
    bridge: boolean;
  };
  source?: GitHubNodeSource;
};

export type RelationEvidence = {
  blockId: string;
  explanation: string;
  sourceUrl?: string;
};

export type KnowledgeEdge = {
  source: string;
  target: string;
  type: RelationKind;
  confidence: number;
  note: string;
  evidence?: RelationEvidence[];
  layer?: RelationLayer;
  origin?: "rule" | "codex" | "display";
  provider?: string;
};

const node = (
  id: string,
  shortLabel: string,
  kind: NodeKind,
  domain: Domain,
  summary: string,
  insight: string,
  tags: string[],
  label = shortLabel,
): KnowledgeNode => ({
  id,
  label,
  shortLabel,
  kind,
  domain,
  summary,
  insight,
  tags,
});

export const knowledgeNodes: KnowledgeNode[] = [
  node(
    "thesis-human-direction",
    "사람이 방향을 정하고, 에이전트가 실행합니다",
    "thesis",
    "agents",
    "AI 시스템의 중심은 완전 자동화가 아니라 책임 있는 방향 설정입니다.",
    "목표와 승인 기준은 사람이 소유하고, 탐색과 실행의 반복은 에이전트가 맡을 때 자동화의 속도와 책임성이 함께 올라갑니다.",
    ["human-in-the-loop", "orchestration", "agency"],
  ),
  node(
    "thesis-context",
    "프롬프트보다 맥락이 결과를 결정합니다",
    "thesis",
    "reasoning",
    "좋은 한 문장보다 필요한 정보가 잘 배열된 환경이 더 안정적인 결과를 만듭니다.",
    "모델 성능의 실전 격차는 지시문 표현보다 어떤 정보·도구·기억을 작업 순간에 제공하느냐에서 발생합니다.",
    ["context", "prompting", "reliability"],
  ),
  node(
    "thesis-memory",
    "기억은 지능을 복리로 성장시킵니다",
    "thesis",
    "memory",
    "매번 처음부터 시작하지 않는 시스템만이 장기적으로 더 똑똑해집니다.",
    "작업 결과와 피드백을 구조화해 다시 검색할 수 있을 때, 다음 실행은 이전 실행의 비용을 자산으로 바꿉니다.",
    ["memory", "knowledge-graph", "compound"],
  ),
  node(
    "thesis-evaluation",
    "검증 루프가 신뢰를 만듭니다",
    "thesis",
    "safety",
    "AI의 신뢰성은 한 번의 정답보다 실패를 발견하고 수정하는 반복 구조에서 나옵니다.",
    "생성자와 평가자를 분리하고, 완료 조건과 중단 기준을 명시하면 고성능 모델의 불확실성을 운영 가능한 품질로 바꿀 수 있습니다.",
    ["evaluation", "trust", "feedback-loop"],
  ),
  node(
    "thesis-system",
    "AI 제품의 자산은 모델이 아니라 시스템입니다",
    "thesis",
    "product",
    "같은 모델을 사용해도 데이터·도구·피드백 구조에 따라 제품의 품질은 크게 달라집니다.",
    "모델은 교체 가능하지만 사용자 맥락, 평가 데이터, 업무 통합, 운영 피드백은 제품에 축적되는 고유 자산입니다.",
    ["product", "system-design", "moat"],
  ),

  node(
    "concept-goal",
    "명시적 목표",
    "concept",
    "reasoning",
    "에이전트가 최적화해야 할 상태를 짧고 검증 가능한 문장으로 정의합니다.",
    "목표가 모호하면 도구가 많아질수록 행동 공간만 커지고 완료 판단은 더 어려워집니다.",
    ["goal", "definition-of-done"],
  ),
  node(
    "concept-context-window",
    "컨텍스트 윈도우",
    "concept",
    "reasoning",
    "한 번의 추론에서 모델이 직접 참고할 수 있는 활성 정보 공간입니다.",
    "크기보다 관련성, 우선순위, 정보 배치 순서가 실제 추론 품질에 더 큰 영향을 줍니다.",
    ["tokens", "attention", "context"],
  ),
  node(
    "concept-planning",
    "계획과 분해",
    "concept",
    "reasoning",
    "복잡한 목표를 순서와 의존성이 있는 작은 작업으로 변환합니다.",
    "계획은 정답 문서가 아니라 실행 중 갱신되는 가설이어야 합니다.",
    ["planning", "decomposition"],
  ),
  node(
    "concept-tool-use",
    "도구 사용",
    "concept",
    "agents",
    "모델이 검색, 계산, 코드 실행, 외부 API 같은 능력을 호출하는 방식입니다.",
    "도구가 많다고 좋은 에이전트가 되는 것은 아닙니다. 호출 조건과 결과 검증 계약이 함께 필요합니다.",
    ["tools", "function-calling"],
  ),
  node(
    "concept-retrieval",
    "의미 기반 검색",
    "concept",
    "memory",
    "질문의 의미와 가까운 기억 조각을 찾아 현재 맥락으로 가져옵니다.",
    "검색 결과의 양보다 중복 제거와 출처 다양성이 응답의 밀도를 좌우합니다.",
    ["retrieval", "semantic-search"],
  ),
  node(
    "concept-provenance",
    "출처 추적",
    "concept",
    "memory",
    "지식이 어디에서 왔고 언제 갱신되었는지를 연결 상태로 보존합니다.",
    "출처 없는 기억은 시간이 지날수록 사실과 추론의 경계를 흐립니다.",
    ["citation", "lineage", "provenance"],
  ),
  node(
    "concept-uncertainty",
    "불확실성 표현",
    "concept",
    "safety",
    "모델이 모르는 영역과 근거가 약한 판단을 결과에 드러내는 방식입니다.",
    "점수 하나보다 근거 부족, 데이터 충돌, 도구 실패처럼 불확실성의 원인을 구분하는 것이 유용합니다.",
    ["confidence", "calibration"],
  ),
  node(
    "concept-feedback",
    "피드백 신호",
    "concept",
    "product",
    "사용자의 수정·채택·거절을 다음 실행 품질을 높이는 신호로 변환합니다.",
    "좋아요 수보다 어느 단계에서 무엇을 고쳤는지가 더 학습 가능한 데이터입니다.",
    ["feedback", "learning-loop"],
  ),

  node(
    "system-agent-loop",
    "에이전트 실행 루프",
    "system",
    "agents",
    "관찰 → 계획 → 행동 → 검증을 반복해 목표 상태에 접근합니다.",
    "루프는 반복 횟수가 아니라 실패 신호와 종료 조건으로 제어해야 합니다.",
    ["agent-loop", "observe-act"],
  ),
  node(
    "system-multi-agent",
    "멀티 에이전트 오케스트레이션",
    "system",
    "agents",
    "역할이 다른 여러 에이전트가 작업과 검증을 분담합니다.",
    "역할 수를 늘리기 전에 공유 상태, 충돌 해결, 최종 책임자를 먼저 설계해야 합니다.",
    ["multi-agent", "coordination"],
  ),
  node(
    "system-router",
    "작업 라우터",
    "system",
    "agents",
    "요청의 난이도와 위험도에 따라 모델·도구·워크플로를 선택합니다.",
    "모든 요청을 가장 큰 모델에 보내는 것보다 분류 오류 비용을 측정하는 라우터가 효율적입니다.",
    ["routing", "model-selection"],
  ),
  node(
    "system-rag",
    "검색 증강 생성",
    "system",
    "memory",
    "외부 지식을 검색해 모델의 현재 맥락에 결합합니다.",
    "RAG는 검색 기술만이 아니라 분할, 랭킹, 인용, 권한 제어를 포함한 전체 파이프라인입니다.",
    ["rag", "retrieval"],
  ),
  node(
    "system-knowledge-graph",
    "관계형 지식 그래프",
    "system",
    "memory",
    "개념·주장·사건을 유형이 있는 방향 관계로 연결합니다.",
    "단순 벡터 유사도가 놓치는 전제, 반박, 구성 관계를 명시적으로 탐색할 수 있습니다.",
    ["graph", "relations", "memory"],
  ),
  node(
    "system-evaluator",
    "독립 평가기",
    "system",
    "safety",
    "생성 결과를 별도의 기준과 모델로 검사합니다.",
    "같은 프롬프트와 맥락을 공유하는 자기 평가는 동일한 맹점을 반복할 수 있습니다.",
    ["evaluator", "quality-gate"],
  ),
  node(
    "system-guardrail",
    "정책 가드레일",
    "system",
    "safety",
    "입력, 도구 호출, 출력 단계마다 허용 범위와 차단 규칙을 적용합니다.",
    "가드레일은 모델을 덜 유능하게 만드는 벽이 아니라 안전한 행동 공간을 정의하는 경계입니다.",
    ["policy", "guardrail"],
  ),
  node(
    "system-observability",
    "AI 관측 가능성",
    "system",
    "infrastructure",
    "프롬프트, 검색 결과, 도구 호출, 비용, 지연, 평가 결과를 하나의 실행 기록으로 남깁니다.",
    "최종 답변만 저장하면 실패가 검색 문제인지 추론 문제인지 구분할 수 없습니다.",
    ["tracing", "observability"],
  ),
  node(
    "system-human-approval",
    "인간 승인 게이트",
    "system",
    "product",
    "외부 영향을 만드는 고위험 행동 직전에 사람의 확인을 요구합니다.",
    "승인은 모든 단계에 넣는 것이 아니라 손실 가능성이 비가역적으로 커지는 경계에 배치해야 합니다.",
    ["approval", "human-in-the-loop"],
  ),

  node(
    "tool-foundation-model",
    "파운데이션 모델",
    "tool",
    "infrastructure",
    "텍스트·이미지·코드 등 여러 작업의 추론 기반이 되는 범용 모델입니다.",
    "모델 선택은 벤치마크 순위보다 실제 업무의 정확도·지연·비용으로 평가해야 합니다.",
    ["model", "multimodal"],
  ),
  node(
    "tool-embedding",
    "임베딩 모델",
    "tool",
    "memory",
    "텍스트나 데이터를 의미 공간의 벡터로 변환합니다.",
    "검색 도메인과 언어에 맞지 않는 임베딩은 인덱스 규모가 커져도 정확도를 회복하기 어렵습니다.",
    ["embedding", "vector"],
  ),
  node(
    "tool-vector-db",
    "벡터 데이터베이스",
    "tool",
    "infrastructure",
    "대규모 임베딩을 저장하고 가까운 항목을 빠르게 검색합니다.",
    "메타데이터 필터와 권한 규칙이 없으면 관련성은 높아도 보여주면 안 되는 정보를 검색할 수 있습니다.",
    ["vector-db", "index"],
  ),
  node(
    "tool-api",
    "도구 API",
    "tool",
    "infrastructure",
    "에이전트가 외부 시스템의 데이터를 읽거나 행동을 실행하는 계약입니다.",
    "읽기와 쓰기 권한을 분리하고 멱등성 키와 감사 로그를 제공해야 안전한 재시도가 가능합니다.",
    ["api", "tools"],
  ),
  node(
    "tool-sandbox",
    "실행 샌드박스",
    "tool",
    "infrastructure",
    "생성된 코드와 명령을 격리된 환경에서 실행합니다.",
    "네트워크, 파일, 시간, 자원 한도를 기본 거부 방식으로 설정해야 합니다.",
    ["sandbox", "code-execution"],
  ),
  node(
    "tool-cache",
    "시맨틱 캐시",
    "tool",
    "infrastructure",
    "의미가 유사한 요청의 검증된 결과를 재사용해 비용과 지연을 줄입니다.",
    "정확히 같은 문자열이 아니라 의미와 사용자 권한이 모두 호환될 때만 재사용해야 합니다.",
    ["cache", "latency", "cost"],
  ),
  node(
    "tool-model-gateway",
    "모델 게이트웨이",
    "tool",
    "infrastructure",
    "여러 모델 공급자의 호출, 제한, 장애 전환, 비용 정책을 통합합니다.",
    "모델 교체 가능성은 API 모양보다 평가 데이터와 관측 체계에서 확보됩니다.",
    ["gateway", "fallback"],
  ),
  node(
    "tool-copilot-ui",
    "코파일럿 인터페이스",
    "tool",
    "product",
    "사용자가 AI의 제안과 근거를 검토하고 수정하는 작업 화면입니다.",
    "대화창만 제공하기보다 현재 업무 객체와 제안의 변경점을 나란히 보여주는 것이 효과적입니다.",
    ["ux", "copilot", "interface"],
  ),

  node(
    "practice-prompt-contract",
    "프롬프트 계약",
    "practice",
    "reasoning",
    "역할, 입력, 출력 형식, 제한, 완료 조건을 명시합니다.",
    "좋은 계약은 모델에게 문체를 지시하는 것이 아니라 결과를 기계적으로 검증할 수 있게 합니다.",
    ["prompt", "schema"],
  ),
  node(
    "practice-chunking",
    "의미 단위 분할",
    "practice",
    "memory",
    "문서를 길이가 아니라 의미가 완결되는 경계로 나눕니다.",
    "질문에 필요한 근거가 여러 조각으로 찢어지면 검색 정확도가 높아도 답변 품질은 낮아집니다.",
    ["chunking", "documents"],
  ),
  node(
    "practice-red-team",
    "레드팀 테스트",
    "practice",
    "safety",
    "의도적으로 경계 사례와 공격 입력을 만들어 시스템의 실패 조건을 찾습니다.",
    "출시 전 일회성 행사가 아니라 실제 실패 로그가 새 테스트로 편입되는 지속 과정이어야 합니다.",
    ["red-team", "adversarial"],
  ),
  node(
    "practice-eval-set",
    "대표 평가 세트",
    "practice",
    "safety",
    "제품의 실제 질문과 위험 사례를 작고 반복 가능한 데이터셋으로 관리합니다.",
    "평균 점수뿐 아니라 실패 유형별 회귀 여부를 추적해야 변경의 안전성을 판단할 수 있습니다.",
    ["evaluation", "regression"],
  ),
  node(
    "practice-progressive-automation",
    "점진적 자동화",
    "practice",
    "product",
    "추천 → 초안 → 승인 실행 → 제한 자동 실행 순서로 권한을 넓힙니다.",
    "정확도뿐 아니라 실패가 발견되는 속도와 복구 가능성을 기준으로 다음 단계로 이동합니다.",
    ["automation", "rollout"],
  ),
  node(
    "practice-cost-budget",
    "비용·지연 예산",
    "practice",
    "product",
    "작업 가치에 따라 토큰, 도구 호출, 재시도 횟수, 응답 시간을 배분합니다.",
    "무제한 반복은 품질 전략이 아니라 종료 조건이 없는 운영 실패입니다.",
    ["cost", "latency", "budget"],
  ),
  node(
    "practice-memory-curation",
    "기억 큐레이션",
    "practice",
    "memory",
    "오래된 기억을 병합하고 충돌을 표시하며 가치가 낮은 정보를 정리합니다.",
    "기억은 추가만 하면 좋아지는 저장소가 아니라 지속적으로 편집해야 하는 지식 제품입니다.",
    ["curation", "memory"],
  ),

  node(
    "risk-hallucination",
    "환각과 근거 없는 확신",
    "risk",
    "safety",
    "모델이 사실처럼 보이는 잘못된 내용이나 출처를 생성할 수 있습니다.",
    "표현의 유창함과 사실성은 별개의 축이므로 검색 근거와 독립 검증이 필요합니다.",
    ["hallucination", "factuality"],
  ),
  node(
    "risk-prompt-injection",
    "프롬프트 인젝션",
    "risk",
    "safety",
    "외부 문서나 사용자가 시스템 지시를 덮어쓰도록 모델을 유도합니다.",
    "신뢰할 수 없는 콘텐츠와 명령을 분리하고 도구 권한을 모델 판단만으로 확대하지 않아야 합니다.",
    ["prompt-injection", "security"],
  ),
  node(
    "risk-data-leak",
    "민감정보 유출",
    "risk",
    "safety",
    "검색·로그·도구 결과를 통해 권한 없는 정보가 응답에 포함될 수 있습니다.",
    "저장 전에 분류하고, 검색 전에 권한을 적용하며, 출력 전에 다시 검사하는 다층 방어가 필요합니다.",
    ["privacy", "data-leak"],
  ),
  node(
    "risk-bias",
    "편향의 자동 증폭",
    "risk",
    "safety",
    "학습 데이터와 운영 피드백의 편향이 반복 자동화를 통해 확대될 수 있습니다.",
    "전체 평균보다 사용자 집단과 상황별 오류율을 분리해 관찰해야 합니다.",
    ["bias", "fairness"],
  ),
  node(
    "risk-agent-loop",
    "통제되지 않은 실행 루프",
    "risk",
    "agents",
    "종료 조건이 약한 에이전트가 비용을 소모하거나 반복 행동을 실행할 수 있습니다.",
    "시간과 토큰 한도만으로는 부족하며 상태 변화와 목표 진척도를 함께 검사해야 합니다.",
    ["runaway-agent", "loop"],
  ),
  node(
    "risk-tool-side-effect",
    "도구의 비가역적 부작용",
    "risk",
    "agents",
    "메일 발송, 결제, 삭제 같은 행동은 잘못 실행되면 되돌리기 어렵습니다.",
    "미리보기, 승인, 멱등성, 보상 트랜잭션을 도구 계약에 포함해야 합니다.",
    ["side-effect", "approval"],
  ),
  node(
    "risk-model-drift",
    "모델·데이터 드리프트",
    "risk",
    "infrastructure",
    "모델 버전이나 사용자 데이터가 바뀌며 기존 품질 기준이 조용히 무너질 수 있습니다.",
    "버전 고정, 회귀 평가, 트래픽 샘플 재평가로 변화의 영향을 추적해야 합니다.",
    ["drift", "regression"],
  ),
];

const edge = (
  source: string,
  target: string,
  type: RelationKind,
  confidence: number,
  note: string,
): KnowledgeEdge => ({ source, target, type, confidence, note });

export const knowledgeEdges: KnowledgeEdge[] = [
  edge("concept-goal", "thesis-human-direction", "supports", 0.96, "사람의 방향 설정을 검증 가능한 목표로 구체화합니다."),
  edge("system-human-approval", "thesis-human-direction", "supports", 0.95, "고위험 행동의 최종 책임을 사람에게 남깁니다."),
  edge("practice-progressive-automation", "thesis-human-direction", "extends", 0.9, "사람과 AI의 권한 경계를 단계적으로 이동시킵니다."),
  edge("system-multi-agent", "thesis-human-direction", "supports", 0.84, "에이전트가 역할별 실행을 분담합니다."),
  edge("risk-tool-side-effect", "thesis-human-direction", "requires", 0.92, "비가역 행동 때문에 인간의 방향·승인 소유권이 필요합니다."),

  edge("concept-context-window", "thesis-context", "supports", 0.96, "활성 맥락의 구조가 추론 결과를 좌우합니다."),
  edge("practice-prompt-contract", "thesis-context", "extends", 0.86, "프롬프트를 맥락 계약의 한 요소로 위치시킵니다."),
  edge("system-rag", "thesis-context", "supports", 0.93, "필요한 외부 지식을 작업 순간에 제공합니다."),
  edge("concept-retrieval", "thesis-context", "supports", 0.91, "관련 기억 선택이 활성 맥락의 품질을 결정합니다."),
  edge("tool-foundation-model", "thesis-context", "contradicts", 0.72, "모델 규모만으로 결과 품질을 설명하는 관점을 제한합니다."),

  edge("system-knowledge-graph", "thesis-memory", "supports", 0.97, "기억 사이 관계를 지속 가능한 구조로 보존합니다."),
  edge("system-rag", "thesis-memory", "supports", 0.91, "축적된 기억을 다음 실행에 재사용합니다."),
  edge("practice-memory-curation", "thesis-memory", "requires", 0.94, "기억이 쌓일수록 편집과 충돌 관리가 필요합니다."),
  edge("concept-provenance", "thesis-memory", "supports", 0.92, "기억의 신뢰도와 갱신 가능성을 보존합니다."),
  edge("concept-feedback", "thesis-memory", "extends", 0.82, "사용자 피드백을 새 기억으로 전환합니다."),

  edge("system-evaluator", "thesis-evaluation", "supports", 0.98, "생성과 평가를 분리해 반복 오류를 줄입니다."),
  edge("practice-eval-set", "thesis-evaluation", "requires", 0.96, "검증 루프가 비교할 안정적인 기준을 제공합니다."),
  edge("concept-uncertainty", "thesis-evaluation", "supports", 0.87, "평가 결과를 단일 통과 점수보다 풍부하게 표현합니다."),
  edge("practice-red-team", "thesis-evaluation", "extends", 0.9, "정상 입력을 넘어 공격 상황까지 검증 범위를 넓힙니다."),
  edge("system-observability", "thesis-evaluation", "requires", 0.93, "실패 원인을 재현할 실행 기록이 필요합니다."),

  edge("concept-feedback", "thesis-system", "supports", 0.94, "제품 사용에서 축적되는 고유 데이터를 만듭니다."),
  edge("system-observability", "thesis-system", "supports", 0.9, "운영 학습이 가능한 시스템 자산을 만듭니다."),
  edge("tool-foundation-model", "thesis-system", "contradicts", 0.83, "모델 자체가 유일한 제품 해자라는 관점을 반박합니다."),
  edge("tool-copilot-ui", "thesis-system", "supports", 0.88, "사용자 작업 맥락과 피드백을 제품에 결합합니다."),
  edge("practice-cost-budget", "thesis-system", "requires", 0.86, "제품 품질을 운영 가능한 비용 안에 유지합니다."),

  edge("concept-goal", "concept-planning", "requires", 0.95, "계획은 명시된 목표를 실행 단위로 분해합니다."),
  edge("concept-planning", "system-agent-loop", "supports", 0.94, "루프의 다음 행동 후보를 생성합니다."),
  edge("concept-tool-use", "system-agent-loop", "supports", 0.92, "루프가 외부 상태를 관찰하고 변경하게 합니다."),
  edge("system-evaluator", "system-agent-loop", "requires", 0.94, "반복을 개선으로 바꾸는 실패 신호를 제공합니다."),
  edge("risk-agent-loop", "system-agent-loop", "risks", 0.98, "종료 기준이 약하면 실행이 통제되지 않을 수 있습니다."),
  edge("practice-cost-budget", "system-agent-loop", "mitigates", 0.88, "재시도와 호출 수에 상한을 둡니다."),

  edge("system-router", "system-multi-agent", "supports", 0.91, "작업을 적합한 역할과 모델로 분배합니다."),
  edge("system-agent-loop", "system-multi-agent", "extends", 0.92, "단일 루프를 역할별 협업 구조로 확장합니다."),
  edge("system-observability", "system-multi-agent", "requires", 0.9, "에이전트 간 책임과 상태 이동을 추적합니다."),
  edge("risk-agent-loop", "system-multi-agent", "risks", 0.9, "동시 루프가 비용과 충돌 가능성을 확대합니다."),
  edge("system-human-approval", "risk-tool-side-effect", "mitigates", 0.96, "비가역 행동 직전에 사람의 확인을 요구합니다."),

  edge("concept-retrieval", "system-rag", "requires", 0.98, "검색이 RAG의 근거 선택 단계를 담당합니다."),
  edge("tool-embedding", "concept-retrieval", "uses", 0.96, "질문과 기억을 비교 가능한 의미 공간으로 변환합니다."),
  edge("tool-vector-db", "concept-retrieval", "uses", 0.94, "대규모 근접 검색을 수행합니다."),
  edge("practice-chunking", "system-rag", "requires", 0.93, "검색 가능한 의미 단위를 만듭니다."),
  edge("concept-provenance", "system-rag", "requires", 0.92, "검색된 근거의 출처를 답변에 연결합니다."),
  edge("risk-hallucination", "system-rag", "mitigates", 0.85, "외부 근거로 사실 생성을 제약합니다."),
  edge("risk-data-leak", "system-rag", "risks", 0.96, "권한 없는 문서가 검색될 수 있습니다."),

  edge("system-knowledge-graph", "concept-retrieval", "extends", 0.89, "벡터 유사도에 관계 탐색을 추가합니다."),
  edge("concept-provenance", "system-knowledge-graph", "supports", 0.94, "관계마다 생성 근거와 출처를 보존합니다."),
  edge("practice-memory-curation", "system-knowledge-graph", "requires", 0.9, "충돌 관계와 오래된 노드를 지속적으로 정리합니다."),
  edge("tool-embedding", "system-knowledge-graph", "uses", 0.76, "명시 관계가 없는 후보 연결을 탐색합니다."),

  edge("practice-eval-set", "system-evaluator", "requires", 0.97, "평가기의 기준과 회귀 사례를 제공합니다."),
  edge("concept-uncertainty", "system-evaluator", "extends", 0.86, "통과 여부와 함께 불확실성 원인을 표시합니다."),
  edge("risk-bias", "system-evaluator", "risks", 0.84, "평가 기준 자체가 편향될 수 있습니다."),
  edge("practice-red-team", "system-guardrail", "supports", 0.92, "우회 가능한 정책 경계를 발견합니다."),
  edge("system-guardrail", "risk-prompt-injection", "mitigates", 0.9, "입력과 명령을 구분하고 도구 권한을 제한합니다."),
  edge("system-guardrail", "risk-data-leak", "mitigates", 0.91, "검색과 출력 단계의 정책 검사를 적용합니다."),
  edge("tool-sandbox", "risk-tool-side-effect", "mitigates", 0.88, "실행 범위와 자원을 격리합니다."),
  edge("tool-sandbox", "concept-tool-use", "supports", 0.88, "생성된 명령을 제한된 환경에서 실행합니다."),

  edge("tool-api", "concept-tool-use", "uses", 0.96, "외부 능력을 호출 가능한 계약으로 제공합니다."),
  edge("risk-prompt-injection", "concept-tool-use", "risks", 0.96, "공격 입력이 권한 있는 도구 호출로 이어질 수 있습니다."),
  edge("risk-tool-side-effect", "concept-tool-use", "risks", 0.98, "도구 호출이 외부 상태를 비가역적으로 바꿀 수 있습니다."),
  edge("system-human-approval", "concept-tool-use", "requires", 0.88, "고위험 도구의 최종 실행 경계를 만듭니다."),

  edge("tool-model-gateway", "system-router", "uses", 0.93, "라우팅 결정에 따라 실제 모델 호출을 수행합니다."),
  edge("tool-foundation-model", "system-router", "uses", 0.91, "작업별로 다른 능력과 비용의 모델을 선택합니다."),
  edge("practice-cost-budget", "system-router", "supports", 0.9, "가치에 맞는 모델과 재시도 정책을 결정합니다."),
  edge("tool-cache", "practice-cost-budget", "supports", 0.87, "검증된 유사 결과를 재사용해 비용을 절감합니다."),
  edge("tool-model-gateway", "risk-model-drift", "mitigates", 0.78, "버전과 공급자 변경을 통제된 경로로 적용합니다."),
  edge("practice-eval-set", "risk-model-drift", "mitigates", 0.94, "모델 변경 전후의 품질 회귀를 측정합니다."),

  edge("system-observability", "risk-model-drift", "mitigates", 0.91, "시간에 따른 품질·비용 변화를 감지합니다."),
  edge("system-observability", "practice-cost-budget", "supports", 0.92, "실제 토큰·지연·도구 호출 비용을 제공합니다."),
  edge("concept-feedback", "system-observability", "uses", 0.84, "사용자 수정 신호를 실행 기록에 연결합니다."),
  edge("risk-data-leak", "system-observability", "risks", 0.86, "상세 추적 로그가 새로운 민감정보 저장소가 될 수 있습니다."),

  edge("tool-copilot-ui", "practice-progressive-automation", "supports", 0.9, "추천과 승인 실행 단계를 사용자에게 노출합니다."),
  edge("concept-feedback", "tool-copilot-ui", "uses", 0.89, "사용자의 수정과 채택을 구조화된 신호로 수집합니다."),
  edge("system-human-approval", "practice-progressive-automation", "requires", 0.94, "자동화 단계별 권한 경계를 제공합니다."),
  edge("risk-bias", "concept-feedback", "risks", 0.8, "편향된 사용 패턴이 다시 시스템에 강화될 수 있습니다."),
  edge("practice-memory-curation", "concept-feedback", "requires", 0.79, "모든 피드백을 영구 기억으로 만들지 않도록 선별합니다."),
];

export const nodeKindLabels: Record<NodeKind, string> = {
  thesis: "핵심 주장",
  concept: "개념",
  system: "시스템",
  tool: "도구",
  practice: "실천",
  risk: "위험",
};

export const domainLabels: Record<Domain, string> = {
  reasoning: "추론",
  agents: "에이전트",
  memory: "기억",
  safety: "안전",
  product: "제품",
  infrastructure: "인프라",
};

export const relationLabels: Record<RelationKind, string> = {
  documents: "문서화",
  plans: "계획",
  contains: "포함",
  implements: "구현",
  depends_on: "의존",
  calls: "호출",
  reads_from: "조회",
  writes_to: "저장",
  produces: "생성",
  tests: "검증",
  references: "참조",
  precedes: "선행",
  blocks: "차단",
  supersedes: "대체",
  same_as: "동일",
  mentions: "언급",
  related_to: "연관",
  supports: "지지",
  extends: "확장",
  requires: "전제",
  uses: "사용",
  mitigates: "완화",
  risks: "위험",
  contradicts: "반론",
};
