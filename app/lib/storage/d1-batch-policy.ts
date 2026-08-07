export const D1_GRAPH_BATCH_STATEMENT_LIMIT = 90;

export function chunkD1Statements<T>(
  statements: readonly T[],
  maximum = D1_GRAPH_BATCH_STATEMENT_LIMIT,
): T[][] {
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new Error("D1 batch 상한은 1 이상의 정수여야 합니다.");
  }
  const chunks: T[][] = [];
  for (let index = 0; index < statements.length; index += maximum) {
    chunks.push(statements.slice(index, index + maximum));
  }
  return chunks;
}

export function assertD1AtomicBatchLimit(
  statements: readonly unknown[],
  label: string,
  maximum = D1_GRAPH_BATCH_STATEMENT_LIMIT,
) {
  if (statements.length > maximum) {
    throw new Error(`${label}이 D1 원자 batch 상한 ${maximum}개를 초과했습니다: ${statements.length}`);
  }
}
