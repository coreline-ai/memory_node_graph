import type { Metadata } from "next";
import KnowledgeGraph from "./knowledge-graph";

export const metadata: Metadata = {
  title: "AI Systems Atlas — 발광형 지식 그래프 데모",
  description:
    "AI 에이전트, 기억, 안전, 제품 구조를 관계로 탐색하는 3D 지식 그래프 프로토타입입니다.",
};

export default function Home() {
  return <KnowledgeGraph />;
}
