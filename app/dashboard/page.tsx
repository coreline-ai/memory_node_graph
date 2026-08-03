import type { Metadata } from "next";
import DashboardClient from "./dashboard-client";
import "./dashboard.css";

export const metadata: Metadata = {
  title: "Atlas Control Room",
  description: "Markdown 문서와 지식 그래프 인덱싱을 관리합니다.",
};

export default function DashboardPage() {
  return <DashboardClient />;
}
