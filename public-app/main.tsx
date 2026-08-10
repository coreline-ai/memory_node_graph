import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../app/globals.css";
import KnowledgeGraph from "../app/knowledge-graph";

const root = document.getElementById("root");

if (!root) throw new Error("공개 Atlas root element를 찾을 수 없습니다.");

createRoot(root).render(
  <StrictMode>
    <KnowledgeGraph dataMode="public-static" />
  </StrictMode>,
);
