import type {
  GitHubReusableDocument,
  GitHubSourceJobInput,
  GitHubSourceJobRecord,
} from "./source-job-contracts";
import {
  listGitHubRepositoryDocuments,
  type GitHubRepositoryDocumentState,
} from "../storage/graph-repository";
import { parserVersionForMarkdownSource } from "../markdown/parser-profiles";

const byPath = (left: GitHubReusableDocument, right: GitHubReusableDocument) =>
  left.path.localeCompare(right.path);

function reusableFromPreview(
  input: GitHubSourceJobInput,
  jobs: readonly GitHubSourceJobRecord[],
  current: readonly GitHubRepositoryDocumentState[],
) {
  const preview = [...jobs].reverse().find((job) =>
    job.kind === "preview"
    && job.status === "completed"
    && job.result?.preview?.status === "ready"
    && job.result.preview.manifestDigest === input.manifestDigest
    && job.result.preview.selectedRepositoryIds.length === 1
    && job.result.preview.selectedRepositoryIds[0] === input.selectedRepositoryIds[0])?.result?.preview;
  const manifest = preview?.repositories[0];
  if (!manifest || manifest.status !== "ready") return null;
  const currentBySource = new Map(current.map((document) => [document.sourceKey, document]));
  return manifest.files.flatMap((file) => {
    const existing = currentBySource.get(file.sourceKey);
    return existing?.sourceDescriptor.blobSha === file.blobSha
      && existing.parserVersion === parserVersionForMarkdownSource(existing.sourceDescriptor)
      ? [{
          repositoryId: manifest.repositoryId,
          path: file.path,
          blobSha: file.blobSha,
          size: file.size,
        } satisfies GitHubReusableDocument]
      : [];
  }).sort(byPath);
}

function reusableFromPreviousApply(
  input: GitHubSourceJobInput,
  jobs: readonly GitHubSourceJobRecord[],
  current: readonly GitHubRepositoryDocumentState[],
) {
  const previous = [...jobs].reverse().find((job) =>
    job.kind === "apply"
    && job.status === "completed"
    && job.result?.apply?.repositoryId === input.selectedRepositoryIds[0]
    && job.result.apply.manifestDigest === input.manifestDigest);
  if (!previous?.result?.apply || previous.result.apply.fileCount !== current.length) return [];
  return current.filter((document) =>
    document.parserVersion === parserVersionForMarkdownSource(document.sourceDescriptor))
    .map((document) => ({
    repositoryId: document.sourceDescriptor.repositoryId,
    path: document.sourceDescriptor.relativePath,
    blobSha: document.sourceDescriptor.blobSha,
    size: document.size,
    })).sort(byPath);
}

export async function attachGitHubApplyReusePlan(
  input: GitHubSourceJobInput,
  jobs: readonly GitHubSourceJobRecord[],
): Promise<GitHubSourceJobInput> {
  if (input.kind !== "apply") return input;
  const current = await listGitHubRepositoryDocuments(input.selectedRepositoryIds[0]);
  const reusableDocuments = reusableFromPreview(input, jobs, current)
    ?? reusableFromPreviousApply(input, jobs, current);
  return { ...input, reusableDocuments };
}
